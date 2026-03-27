import { Router } from "express";
import { searchAll } from "../controllers/searchController";
import { scoreListings } from "../services/scoring/scoreListing";

const router = Router();

// GET /api/search?query=...&limit=16
router.get("/", searchAll);

// POST /api/analyze — analyze a single listing on demand
router.post("/analyze", async (req, res) => {
  const listing = req.body;
  if (!listing || !listing.id || !listing.source) {
    return res.status(400).json({ error: "Missing listing id or source" });
  }
  try {
    const [result] = await scoreListings([listing]);
    return res.json({ ...result, analyzedAt: new Date().toISOString() });
  } catch (err: any) {
    console.error("analyze error:", err);
    const message = err?.message ?? err?.error?.message ?? String(err);
    return res.status(500).json({ error: message });
  }
});

export default router;
