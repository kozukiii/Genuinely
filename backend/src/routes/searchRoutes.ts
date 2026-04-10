import { Router } from "express";
import { searchAll } from "../controllers/searchController";
import { scoreListings } from "../services/scoring/scoreListing";
import { groupAndContextualize } from "../ai/listingContext";
import { getEbayItemByNumericId } from "../services/ebayService";
import { getMarketplaceListingByGraphqlForAnalysis, getMarketplaceListingBySearchForAnalysis } from "../services/marketplaceService";
import { getLocationFromIp, extractClientIp } from "../utils/geoIp";

const router = Router();

async function enrichMarketplaceImages(listing: any): Promise<any> {
  if (listing.source !== "marketplace" || !listing.id) return listing;

  const existingImages: string[] = Array.isArray(listing.images) ? listing.images : [];
  if (existingImages.length >= 2) return listing; // already has multiple images

  try {
    const detailed = await getMarketplaceListingByGraphqlForAnalysis(listing.id);
    const detailImages: string[] = Array.isArray(detailed.images) ? detailed.images : [];
    if (detailImages.length > existingImages.length) {
      return { ...listing, images: detailImages };
    }
  } catch (err) {
    console.warn(`[analyze] Image enrichment failed for marketplace listing ${listing.id}:`, err);
  }

  return listing;
}

async function scoreSingleListingWithContext(listing: any) {
  const enriched = await enrichMarketplaceImages(listing);

  const title =
    typeof enriched?.title === "string" && enriched.title.trim()
      ? enriched.title.trim()
      : null;

  if (!title) {
    const [result] = await scoreListings([enriched], null);
    return result;
  }

  const groups = await groupAndContextualize([title], title);
  const group = groups[0] ?? null;

  const [result] = await scoreListings([enriched], null, group?.systemPrompt ?? null);

  return {
    ...result,
    ...(group?.priceLow  != null ? { priceLow:  group.priceLow  } : {}),
    ...(group?.priceHigh != null ? { priceHigh: group.priceHigh } : {}),
  };
}

// GET /api/search?query=...&limit=16
router.get("/", searchAll);

// POST /api/analyze — analyze a single listing on demand
router.post("/analyze", async (req, res) => {
  const listing = req.body;
  if (!listing || !listing.id || !listing.source) {
    return res.status(400).json({ error: "Missing listing id or source" });
  }
  try {
    const result = await scoreSingleListingWithContext(listing);
    return res.json({ ...result, analyzedAt: new Date().toISOString() });
  } catch (err: any) {
    console.error("analyze error:", err);
    const message = err?.message ?? err?.error?.message ?? String(err);
    return res.status(500).json({ error: message });
  }
});

// POST /api/search/from-url — fetch and analyze a listing by URL
router.post("/from-url", async (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "Missing url" });
  }

  try {
    const ebayMatch = url.match(/ebay\.com\/itm\/(?:[^/?#]+\/)?(\d{8,})/);
    const mpMatch = url.match(/facebook\.com\/marketplace\/item\/(\d+)/);

    if (!ebayMatch && !mpMatch) {
      return res.status(400).json({
        error: "Unsupported URL. Paste an eBay or Facebook Marketplace listing link.",
      });
    }

    const countryFallback = String(req.body.country ?? "").trim().toUpperCase();
    const ipLoc = ebayMatch
      ? await getLocationFromIp(extractClientIp(req as any)).catch(() => null)
      : null;
    const buyerLocation = ebayMatch
      ? (ipLoc ?? (countryFallback ? { country: countryFallback, zip: "" } : null))
      : null;

    let listing = ebayMatch
      ? await getEbayItemByNumericId(ebayMatch[1], buyerLocation)
      : await getMarketplaceListingBySearchForAnalysis(mpMatch![1]);

    // price===null means the price field was absent from the API response —
    // not the same as "Accepts Offers". Reject rather than analyze bad data.
    if (!ebayMatch && listing.price === null) {
      return res.status(404).json({
        error: "This Marketplace listing's price couldn't be retrieved. It may be a cross-platform listing — try finding it directly on eBay.",
      });
    }

    const analyzed = await scoreSingleListingWithContext(listing);
    return res.json({ ...analyzed, analyzedAt: new Date().toISOString() });
  } catch (err: any) {
    console.error("from-url error:", err);
    const message = err?.message ?? "Failed to fetch listing";
    const status = /unavailable|unexpected page|login required|not configured/i.test(message)
      ? 404
      : 500;
    return res.status(status).json({ error: message });
  }
});

// POST /api/search/context
// Takes listings + query, groups by product, fetches Tavily context per group.
// Returns groups with indices into the listings array and market context strings.
router.post("/context", async (req, res) => {
  const { query, listings } = req.body;
  if (!query || typeof query !== "string") {
    return res.status(400).json({ error: "Missing query" });
  }
  if (!Array.isArray(listings)) {
    return res.status(400).json({ error: "listings must be an array" });
  }

  try {
    const titles: string[] = listings.map((l: any) => (typeof l.title === "string" ? l.title : ""));
    const groups = await groupAndContextualize(titles, query);
    return res.json({ groups });
  } catch (err: any) {
    console.error("context error:", err);
    return res.status(500).json({ error: err?.message ?? "Context generation failed" });
  }
});

// POST /api/search/batch-analyze
// Accepts { listings, systemPrompt } — scores a batch with a pre-generated product-expert prompt.
// systemPrompt replaces the static system prompt for this group of listings.
router.post("/batch-analyze", async (req, res) => {
  const { listings, systemPrompt } = req.body;
  if (!Array.isArray(listings)) {
    return res.status(400).json({ error: "listings must be an array" });
  }

  try {
    const scored = await scoreListings(listings, null, systemPrompt ?? null);
    return res.json(scored);
  } catch (err: any) {
    console.error("batch-analyze error:", err);
    return res.status(500).json({ error: err?.message ?? "Batch analysis failed" });
  }
});

export default router;
