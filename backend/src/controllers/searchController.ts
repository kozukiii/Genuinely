import type { Request, Response } from "express";
import type { Listing } from "../types/listing";

import { searchEbayPage } from "../services/ebayService";
import { searchMarketplaceNormalized } from "../services/marketplaceService";
import { scoreListings } from "../services/scoring/scoreListing";
import { fetchMarketContext } from "../ai/listingContext";
import { getLocationFromIp, extractClientIp, getMarketplaceSearchLocation } from "../utils/geoIp";
import { signListingForAnalysis } from "../services/listingAnalysisProof";

function clampInt(n: number, min: number, max: number) {
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : min;
}

function dedupe(items: Listing[]) {
  const seen = new Set<string>();
  const out: Listing[] = [];
  for (const it of items) {
    const key = `${it.source}:${it.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

function parseFlag(v: unknown): boolean {
  const s = String(v ?? "0").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

export async function searchAll(req: Request, res: Response) {
  const query = String(req.query.query ?? "").trim();
  if (!query) return res.status(400).json({ error: "Missing query" });

  const limit = clampInt(Number(req.query.limit ?? 15), 1, 200);
  const analyze = parseFlag(req.query.analyze);
  const continuation = parseFlag(req.query.continuation);

  const sourcesRaw = String(req.query.sources ?? "ebay,marketplace")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const offset = clampInt(Number(req.query.offset ?? 0), 0, 10000);

  const wantsEbay = sourcesRaw.includes("ebay");
  const wantsMarketplace = sourcesRaw.includes("marketplace");

  const useEbay = wantsEbay || (!wantsEbay && !wantsMarketplace);
  // Skip marketplace on offset pages — the client already has those from the first fetch
  const useMarketplace = wantsMarketplace && offset === 0 && !continuation;

  const sourceCount = (useEbay ? 1 : 0) + (useMarketplace ? 1 : 0);
  const perSource = Math.max(1, Math.floor(limit / Math.max(1, sourceCount)));

  const ebayTarget = useEbay ? perSource : 0;
  const marketplaceTarget = useMarketplace ? limit - ebayTarget : 0;

  const requestedLocation = String(req.query.location ?? "").trim();

  const rawMin = req.query.minPrice ? Number(req.query.minPrice) : undefined;
  const rawMax = req.query.maxPrice ? Number(req.query.maxPrice) : undefined;
  const minPrice = rawMin != null && Number.isFinite(rawMin) ? rawMin : undefined;
  const maxPrice = rawMax != null && Number.isFinite(rawMax) ? rawMax : undefined;

  const sortByRaw = String(req.query.sortBy ?? "").trim();
  const sortBy = (sortByRaw === "price_asc" || sortByRaw === "price_desc") ? sortByRaw : undefined;

  const rawRadius = req.query.radiusKm ? Number(req.query.radiusKm) : undefined;
  const radiusKm = rawRadius != null && Number.isFinite(rawRadius) && rawRadius > 0 ? rawRadius : undefined;

  // IP geolocation gives us a real zip code that eBay can use to resolve calculated
  // shipping costs. Fall back to the frontend-supplied country if IP lookup fails.
  const countryFallback = String(req.query.country ?? "").trim().toUpperCase();
  const needsGeoIp = useEbay || (useMarketplace && !requestedLocation);
  const ipLoc = needsGeoIp
    ? await getLocationFromIp(extractClientIp(req as any)).catch(() => null)
    : null;
  // If the user specified a zip, it overrides GeoIP for both eBay (shipping cost
  // resolution) and Marketplace (search center). Otherwise fall back to GeoIP.
  const buyerLocation = requestedLocation
    ? { country: ipLoc?.country ?? countryFallback ?? "US", zip: requestedLocation }
    : (ipLoc ?? (countryFallback ? { country: countryFallback, zip: "" } : null));
  const marketplaceSearchLocation = requestedLocation
    ? { location: requestedLocation }
    : getMarketplaceSearchLocation(ipLoc);


  // Start market context fetch in parallel with API searches (only when analyze=1)
  const contextPromise = analyze ? fetchMarketContext(query) : Promise.resolve(null);

  let marketplaceUnavailable = false;
  const marketplacePromise = useMarketplace
    ? marketplaceSearchLocation
      ? searchMarketplaceNormalized({
          query,
          ...marketplaceSearchLocation,
          limit: marketplaceTarget || 10,
          radiusKm,
          enrichImages: false,
        }).catch((err) => {
          marketplaceUnavailable = true;
          console.error("searchMarketplaceNormalized failed", err);
          return [] as Listing[];
        })
      : (() => {
          marketplaceUnavailable = true;
          console.warn("searchMarketplaceNormalized skipped: no explicit location or GeoIP location was available");
          return Promise.resolve([] as Listing[]);
        })()
    : Promise.resolve([] as Listing[]);

  // Reserve space for Marketplace, but start both source requests together.
  const ebayPromise = useEbay
    ? searchEbayPage(query, ebayTarget, buyerLocation, minPrice, maxPrice, sortBy, offset)
    : Promise.resolve({ items: [] as Listing[], hasMore: false, nextOffset: offset, unavailable: false, remainingWindows: 0 });
  const [marketplace, initialEbay] = await Promise.all([marketplacePromise, ebayPromise]);
  const validMarketplace = dedupe(marketplace.filter((l: Listing) => l.price !== null)).slice(0, marketplaceTarget);
  let ebay = initialEbay;
  const remaining = limit - validMarketplace.length - ebay.items.length;
  if (useEbay && remaining > 0 && ebay.hasMore && !ebay.unavailable && ebay.remainingWindows > 0) {
    // Refill from the returned raw cursor without exceeding the request's scan budget.
    const extra = await searchEbayPage(query, remaining, buyerLocation, minPrice, maxPrice, sortBy, ebay.nextOffset, ebay.remainingWindows);
    ebay = { ...extra, items: dedupe([...ebay.items, ...extra.items]) };
  }
  const ebayUnavailable = ebay.unavailable;
  const merged = dedupe([...ebay.items, ...validMarketplace]);
  res.setHeader("X-Search-Has-More", String(ebay.hasMore));
  res.setHeader("X-Search-Next-Offset", String(ebay.nextOffset));

  // Shuffle only on the first page so eBay and marketplace are interleaved.
  // Skip when sorting by price (preserve eBay's native order) or when offset > 0
  // (incremental pages should come in stable eBay order so appending is consistent).
  if (!sortBy && offset === 0 && !continuation) {
    for (let i = merged.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [merged[i], merged[j]] = [merged[j], merged[i]];
    }
  }

  const finalItems = merged
    .slice(0, limit)
    .map((listing) => signListingForAnalysis({ ...listing, analysisQuery: query }));
  res.setHeader(
    "X-Ebay-Search-Status",
    useEbay ? (ebayUnavailable ? "unavailable" : "ok") : "not-requested"
  );
  res.setHeader(
    "X-Marketplace-Search-Status",
    useMarketplace ? (marketplaceUnavailable ? "unavailable" : "ok") : "not-requested"
  );

  if (analyze) {
    const context = await contextPromise;
    const analyzed = await scoreListings(finalItems, context);
    return res.json(analyzed.map(signListingForAnalysis));
  }

  return res.json(finalItems);
}
