import { Router } from "express";
import db from "../db";
import { requireAuth } from "../middleware/auth";

const router = Router();

// Fields we never want to persist (large, ephemeral, or debug-only)
const STRIP_FIELDS = new Set(["debugInfo", "rawAnalysis", "systemPrompt", "marketContext", "analysisPending"]);

function stripListing(listing: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(listing)) {
    if (!STRIP_FIELDS.has(k)) out[k] = v;
  }
  return out;
}

// GET /api/saved
router.get("/", requireAuth, (req, res) => {
  const rows = db.prepare(
    "SELECT data FROM saved_listings WHERE user_id = ? ORDER BY saved_at DESC"
  ).all(req.user!.id) as { data: string }[];

  const listings = rows.map((r) => {
    try { return JSON.parse(r.data); } catch { return null; }
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

// DELETE /api/saved/:source/:id
router.delete("/:source/:id", requireAuth, (req, res) => {
  db.prepare(
    "DELETE FROM saved_listings WHERE user_id = ? AND source = ? AND listing_id = ?"
  ).run(req.user!.id, req.params.source, req.params.id);

  res.json({ ok: true });
});

export default router;
