// ─── Combined cross-group scoring in ONE Groq Batch job ──────────────────────
//
// The live search splits results into product groups, each with its own context/
// system prompt. Scoring each group as its own batch job means N batch lifecycles
// (Groq serializes batches per account), which trickles results in over ~35s.
//
// This builds every listing across every group into a SINGLE batch job — each
// listing carrying its own group's system prompt — so the whole search pays one
// batch lifecycle. Results are parsed back per-listing with the right group's
// context. On failure the caller falls back to the per-group path.

import { buildEbayAnalysisMessages } from "../../ai/ebayOverview";
import { buildMarketplaceAnalysisMessages } from "../../ai/marketplaceOverview";
import { runRawChatBatch } from "../../ai/groqBatchRun";
import { scoreEbayItemFromRaw } from "../aiService";
import { scoreMarketplaceListingFromRaw } from "./scoreMarketplaceListing";

export interface ScoringGroup {
  listings: any[];
  context?: string | null;
  systemPrompt?: string | null;
  priceLow?: number | null;
  priceHigh?: number | null;
}

interface Unit {
  source: "ebay" | "marketplace";
  listing: any;
  group: ScoringGroup;
  messages: any[];
}

/**
 * Score every listing across all groups in one batch job. Returns the scored
 * listings flattened in group/listing order (same order they were provided).
 */
export async function scoreGroupsInOneBatch(groups: ScoringGroup[]): Promise<any[]> {
  // Build each listing's messages (marketplace fetches images) — all in parallel.
  const units: Unit[] = await Promise.all(
    groups.flatMap((group) =>
      group.listings.map(async (listing): Promise<Unit> => {
        const source: "ebay" | "marketplace" = listing.source === "marketplace" ? "marketplace" : "ebay";
        const messages = source === "marketplace"
          ? await buildMarketplaceAnalysisMessages(listing, group.context)
          : await buildEbayAnalysisMessages(listing, group.context);
        // Prepend the group's system prompt (price range, condition signals) to
        // the generic per-listing instructions.
        if (group.systemPrompt && messages[0]?.role === "system") {
          messages[0].content = `${group.systemPrompt}\n\n${messages[0].content}`;
        }
        return { source, listing, group, messages };
      })
    )
  );

  if (units.length === 0) return [];

  const raw = await runRawChatBatch(units.map((u) => u.messages), "search-combined", { timeoutMs: 120_000 });

  return units.map((u, i) => {
    const r = raw[i] ?? "{}";
    return u.source === "marketplace"
      ? scoreMarketplaceListingFromRaw(u.listing, r, u.group.context, u.group.systemPrompt, u.group.priceLow, u.group.priceHigh)
      : scoreEbayItemFromRaw(u.listing, r, u.group.context, u.group.systemPrompt, u.group.priceLow, u.group.priceHigh);
  });
}
