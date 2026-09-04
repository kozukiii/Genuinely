// Cross-group scoring through bounded concurrent Groq Chat Completions. Each
// request carries the listing's own product-group context and response schema.

import { buildEbayAnalysisMessages } from "../../ai/ebayOverview";
import { buildMarketplaceAnalysisMessages } from "../../ai/marketplaceOverview";
import { runRawChatRequests } from "../../ai/groqBatchRun";
import { scoreEbayItemFromRaw } from "../aiService";
import { scoreMarketplaceListingFromRaw } from "./scoreMarketplaceListing";

export interface ScoringGroup {
  listings: any[];
  context?: string | null;
  systemPrompt?: string | null;
  priceLow?: number | null;
  priceHigh?: number | null;
  priceSource?: string | null;
  priceChartingUrl?: string | null;
  tcgPlayerUrl?: string | null;
}

interface Unit {
  source: "ebay" | "marketplace";
  listing: any;
  group: ScoringGroup;
  messages: any[];
}

/**
 * Score every listing across all groups and preserve group/listing order.
 */
export async function scoreGroupsViaChat(groups: ScoringGroup[]): Promise<any[]> {
  // Build each listing's messages (marketplace fetches images) — all in parallel.
  const units: Unit[] = await Promise.all(
    groups.flatMap((group) =>
      group.listings.map(async (listing): Promise<Unit> => {
        const source: "ebay" | "marketplace" = listing.source === "marketplace" ? "marketplace" : "ebay";
        let messages: any[];
        try {
          messages = source === "marketplace"
            ? await buildMarketplaceAnalysisMessages(listing, group.context)
            : await buildEbayAnalysisMessages(listing, group.context);
        } catch {
          // Never analyze silently missing photos, but do not discard the other
          // listings because one listing's image host is unavailable.
          console.warn(`[search-combined] image preparation failed for ${source} listing; preserving other results`);
          return { source, listing, group, messages: [] };
        }
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

  const ready = units.filter((u) => u.messages.length > 0);
  const raw = await runRawChatRequests(ready.map((u) => u.messages), "search-combined", {
    schemas: ready.map((u) => u.source === "ebay" ? "ebay-single" : "marketplace-single"),
    allowPartial: true,
  });
  const rawByUnit = new Map(ready.map((u, i) => [u, raw[i]]));

  return units.map((u) => {
    const r = rawByUnit.get(u);
    if (!r) return { ...u.listing, aiScore: null, analysisPending: false };
    const priceMeta = {
      priceSource: u.group.priceSource ?? null,
      priceChartingUrl: u.group.priceChartingUrl ?? null,
      tcgPlayerUrl: u.group.tcgPlayerUrl ?? null,
    };
    return u.source === "marketplace"
      ? scoreMarketplaceListingFromRaw(u.listing, r, u.group.context, u.group.systemPrompt, u.group.priceLow, u.group.priceHigh, priceMeta)
      : scoreEbayItemFromRaw(u.listing, r, u.group.context, u.group.systemPrompt, u.group.priceLow, u.group.priceHigh, priceMeta);
  });
}
