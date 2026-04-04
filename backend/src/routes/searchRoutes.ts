import { Router } from "express";
import { searchAll } from "../controllers/searchController";
import { scoreListings } from "../services/scoring/scoreListing";
import { fetchMarketContext } from "../ai/priceContext";
import { getEbayItemByNumericId } from "../services/ebayService";
import { getMarketplaceListingBySearchForAnalysis } from "../services/marketplaceService";

const router = Router();

async function scoreSingleListingWithContext(listing: any) {
  const contextQuery =
    typeof listing?.title === "string" && listing.title.trim()
      ? listing.title.trim()
      : null;

  const context = contextQuery ? await fetchMarketContext(contextQuery) : null;
  const [result] = await scoreListings([listing], context);
  return result;
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

    const countryRaw = String(req.body.country ?? "").trim().toUpperCase();
    const buyerLocation = ebayMatch && countryRaw ? { country: countryRaw, zip: "" } : null;

    const listing = ebayMatch
      ? await getEbayItemByNumericId(ebayMatch[1], buyerLocation)
      : await getMarketplaceListingBySearchForAnalysis(mpMatch![1]);

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

export default router;
