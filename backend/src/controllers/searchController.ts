import type { Request, Response } from "express";
import type { Listing } from "../types/listing";

import { searchEbayNormalized } from "../services/ebayService";
import { searchMarketplaceNormalized } from "../services/marketplaceService";
import { analyzeItemsWithAI } from "../services/aiService";

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

  const limit = clampInt(Number(req.query.limit ?? 64), 1, 64);

  // ✅ analyze=1 runs AI, analyze=0 skips (demo mode)
  const analyze = parseAnalyzeFlag(req.query.analyze);

  // ✅ parse sources=ebay,marketplace (defaults to both)
  const sourcesRaw = String(req.query.sources ?? "ebay,marketplace")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const wantsEbay = sourcesRaw.includes("ebay");
  const wantsMarketplace = sourcesRaw.includes("marketplace");

  // If caller passes junk (or nothing valid), default to ebay
  const useEbay = wantsEbay || (!wantsEbay && !wantsMarketplace);
  const useMarketplace = wantsMarketplace;

  const sourceCount = (useEbay ? 1 : 0) + (useMarketplace ? 1 : 0);
  const perSource = Math.floor(limit / sourceCount);

  const ebayTarget = useEbay ? perSource : 0;
  const marketplaceTarget = useMarketplace ? (limit - ebayTarget) : 0;

  const [marketplace, ebay] = await Promise.all([
    useMarketplace
      ? searchMarketplaceNormalized(query, marketplaceTarget).catch(() => [])
      : Promise.resolve([]),
    useEbay
      ? searchEbayNormalized(query, ebayTarget).catch(() => [])
      : Promise.resolve([]),
  ]);

  let merged = dedupe([...ebay, ...marketplace]);

  // fallback-fill with ebay if we’re short (only if ebay enabled)
  if (merged.length < limit && useEbay) {
    const need = limit - merged.length;
    const extra = await searchEbayNormalized(query, ebayTarget + need).catch(() => []);
    merged = dedupe([...merged, ...extra]);
  }

  const finalItems = merged.slice(0, limit);

  // ✅ Only burn tokens if analyze is true
  if (analyze) {
    const analyzed = await analyzeItemsWithAI(finalItems);
    return res.json(analyzed);
  }

  return res.json(finalItems);
}
