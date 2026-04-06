import type { Request, Response } from "express";
import type { Listing } from "../types/listing";

import { searchEbayNormalized } from "../services/ebayService";
import { searchMarketplaceNormalized } from "../services/marketplaceService";
import { scoreListings } from "../services/scoring/scoreListing";
import { fetchMarketContext } from "../ai/priceContext";

function clampInt(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
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

function parseAnalyzeFlag(v: unknown): boolean {
  const s = String(v ?? "0").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

export async function searchAll(req: Request, res: Response) {
  const query = String(req.query.query ?? "").trim();
  if (!query) return res.status(400).json({ error: "Missing query" });

  const limit = clampInt(Number(req.query.limit ?? 15), 1, 200);
  const analyze = parseAnalyzeFlag(req.query.analyze);

  const sourcesRaw = String(req.query.sources ?? "ebay,marketplace")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const offset = clampInt(Number(req.query.offset ?? 0), 0, 10000);

  const wantsEbay = sourcesRaw.includes("ebay");
  const wantsMarketplace = sourcesRaw.includes("marketplace");

  const useEbay = wantsEbay || (!wantsEbay && !wantsMarketplace);
  // Skip marketplace on offset pages — the client already has those from the first fetch
  const useMarketplace = wantsMarketplace && offset === 0;

  const sourceCount = (useEbay ? 1 : 0) + (useMarketplace ? 1 : 0);
  const perSource = Math.floor(limit / sourceCount);

  const ebayTarget = useEbay ? perSource : 0;
  const marketplaceTarget = useMarketplace ? limit - ebayTarget : 0;

  const location = String(req.query.location ?? "Eau Claire").trim();

  const rawMin = req.query.minPrice ? Number(req.query.minPrice) : undefined;
  const rawMax = req.query.maxPrice ? Number(req.query.maxPrice) : undefined;
  const minPrice = rawMin != null && Number.isFinite(rawMin) ? rawMin : undefined;
  const maxPrice = rawMax != null && Number.isFinite(rawMax) ? rawMax : undefined;

  const sortByRaw = String(req.query.sortBy ?? "").trim();
  const sortBy = (sortByRaw === "price_asc" || sortByRaw === "price_desc") ? sortByRaw : undefined;

  const countryRaw = String(req.query.country ?? "").trim().toUpperCase();
  const buyerLocation = countryRaw ? { country: countryRaw, zip: "" } : null;

  // Start market context fetch in parallel with API searches (only when analyze=1)
  const contextPromise = analyze ? fetchMarketContext(query) : Promise.resolve(null);

  let ebayUnavailable = false;
  const runEbaySearch = async (target: number) => {
    try {
      return await searchEbayNormalized(query, target, buyerLocation, minPrice, maxPrice, sortBy, offset);
    } catch (err) {
      ebayUnavailable = true;
      console.error("searchEbayNormalized failed", err);
      return [] as Listing[];
    }
  };

  const [marketplace, ebay] = await Promise.all([
    useMarketplace
      ? searchMarketplaceNormalized({
          query,
          location,
          limit: marketplaceTarget || 10,
        }).catch((err) => {
          console.error("searchMarketplaceNormalized failed", err);
          return [] as Listing[];
        })
      : Promise.resolve([]),
    useEbay && ebayTarget > 0 ? runEbaySearch(ebayTarget) : Promise.resolve([]),
  ]);

  // Drop marketplace listings where price is null — that means the price field
  // was absent from the API response (e.g. cross-platform partner listings).
  // price===0 is valid and means "Accepts Offers".
  const validMarketplace = marketplace.filter((l: Listing) => l.price !== null);
  let merged = dedupe([...ebay, ...validMarketplace]);

  if (merged.length < limit && useEbay && !ebayUnavailable) {
    const need = limit - merged.length;
    const extra = await runEbaySearch(ebayTarget + need);
    merged = dedupe([...merged, ...extra]);
  }

  // Shuffle only on the first page so eBay and marketplace are interleaved.
  // Skip when sorting by price (preserve eBay's native order) or when offset > 0
  // (incremental pages should come in stable eBay order so appending is consistent).
  if (!sortBy && offset === 0) {
    for (let i = merged.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [merged[i], merged[j]] = [merged[j], merged[i]];
    }
  }

  const finalItems = merged.slice(0, limit);
  res.setHeader(
    "X-Ebay-Search-Status",
    useEbay ? (ebayUnavailable ? "unavailable" : "ok") : "not-requested"
  );

  if (analyze) {
    const context = await contextPromise;
    const analyzed = await scoreListings(finalItems, context);
    return res.json(analyzed);
  }

  return res.json(finalItems);
}
