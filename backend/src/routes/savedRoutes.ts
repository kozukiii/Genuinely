import { Router } from "express";
import db from "../db";
import { requireAuth } from "../middleware/auth";
import { getEbayItemByNumericId } from "../services/ebayService";
import { getMarketplaceListingByGraphqlForAnalysis } from "../services/marketplaceService";

const router = Router();

// ToS-safe persistence: we store ONLY our own analysis output + the listing's
// identity. We never write the source's copyrighted content (title, description,
// images, seller, price, condition, url) to the persistent disk. On a device with
// no localStorage cache, the saved page re-fetches that live content via /hydrate.
//
// This is an ALLOWLIST on purpose. A blacklist (strip a few debug fields) silently
// persisted everything else — that's how scraped content ended up on disk.
const ALLOWED_FIELDS = new Set([
  // identity (required to re-fetch live content)
  "id", "source", "crossListedEbayId",
  // our analysis output
  "score", "aiScore", "aiScores", "overview", "highlights",
  // market price context (our derived data, not the seller's listing)
  "priceLow", "priceHigh", "priceSource", "priceChartingUrl", "tcgPlayerUrl",
  // availability / freshness metadata
  "availabilityStatus", "availabilityCheckedAt", "availabilityReason",
  "lastSeenActiveAt", "endedAt", "analysisSkipped", "analyzedAt",
]);

function stripListing(listing: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(listing)) {
    if (ALLOWED_FIELDS.has(k)) out[k] = v;
  }
  return out;
}

// GET /api/saved
router.get("/", requireAuth, async (req, res) => {
  const rows = db.prepare(
    "SELECT source, listing_id, data FROM saved_listings WHERE user_id = ? ORDER BY saved_at DESC"
  ).all(req.user!.id) as { source: string; listing_id: string; data: string }[];

  const listings = rows.map((r) => {
    try {
      const data = JSON.parse(r.data);
      return data && typeof data === "object" ? data : null;
    } catch { return null; }
  }).filter(Boolean);
  res.json({ listings });
});

// POST /api/saved  — body: { listing: Listing }
router.post("/", requireAuth, (req, res) => {
  const listing = req.body?.listing as Record<string, unknown> | undefined;
  if (!listing?.id || !listing?.source) {
    res.status(400).json({ error: "listing.id and listing.source are required" });
    return;
  }

  const data = JSON.stringify(stripListing(listing));
  db.prepare(`
    INSERT INTO saved_listings (user_id, source, listing_id, data)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, source, listing_id) DO UPDATE SET data = excluded.data, saved_at = unixepoch()
  `).run(req.user!.id, listing.source, listing.id, data);

  res.json({ ok: true });
});

// POST /api/saved/hydrate — body: { items: [{ source, id }] }
// Re-fetches live listing content (title/images/price/etc.) from the source for
// saved stubs whose content isn't cached locally. We deliberately do NOT persist
// this content; it's fetched fresh and held only in the client's localStorage.
router.post("/hydrate", requireAuth, async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : null;
  if (!items) {
    res.status(400).json({ error: "items must be an array" });
    return;
  }

  const listings = await Promise.all(
    items.slice(0, 24).map(async (item: any) => {
      const source = item?.source;
      const id = String(item?.id ?? "");
      if (!source || !id) return null;
      try {
        if (source === "ebay") {
          const numericId = id.match(/\d{8,}/)?.[0];
          if (!numericId) return null;
          return await getEbayItemByNumericId(numericId, null);
        }
        if (source === "marketplace") {
          return await getMarketplaceListingByGraphqlForAnalysis(id);
        }
      } catch {
        // Listing may be removed/unavailable — skip; the stub's availability
        // metadata already tells the UI it's no longer live.
        return null;
      }
      return null;
    })
  );

  res.json({ listings: listings.filter(Boolean) });
});

// DELETE /api/saved/:source/:id
router.delete("/:source/:id", requireAuth, (req, res) => {
  db.prepare(
    "DELETE FROM saved_listings WHERE user_id = ? AND source = ? AND listing_id = ?"
  ).run(req.user!.id, req.params.source, req.params.id);

  res.json({ ok: true });
});

export default router;
