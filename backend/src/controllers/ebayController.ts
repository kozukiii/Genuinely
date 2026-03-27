import { Request, Response } from "express";
import {
  getEbayItemsWithDetails,
  getEbayRateLimits,
} from "../services/ebayService";
import {
  
  analyzeItemsWithAI
} from "../services/aiService";



// Overview — now returns up to 8 AI-analyzed items
export async function overviewSearch(req: Request, res: Response) {
  try {
    const query = req.query.query as string;
    if (!query) {
      return res.status(400).json({ error: "Missing query parameter" });
    }

    // Optional: allow ?limit= on the querystring, default to 8
    const limitParam = req.query.limit as string | undefined;
    const limit = limitParam ? Math.min(parseInt(limitParam, 10) || 1, 64) : 64;

    // Step 1 — get up to `limit` items with full details
    const mergedItems = await getEbayItemsWithDetails(query, limit);

    if (!mergedItems.length) {
      return res.json([]);
    }

    // Step 2 — run AI on each item
    const analyzed = await analyzeItemsWithAI(mergedItems);

    // Step 3 — return an array of analyzed listings
    res.json(analyzed);
  } catch (err: any) {
    console.error("AI Route Error:", err);
    const message = err?.message ?? err?.error?.message ?? String(err);
    res.status(500).json({ error: message });
  }
}

export async function rateLimits(req: Request, res: Response) {
  try {
    const data = await getEbayRateLimits();
    res.json(data);
  } catch (err) {
    console.error("eBay rate limits error:", err);
    const message = err instanceof Error ? err.message : "Failed to fetch eBay rate limits";
    res.status(500).json({ error: message });
  }
}
