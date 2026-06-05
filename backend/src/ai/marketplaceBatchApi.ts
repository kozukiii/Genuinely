// ─── Groq Batch API path for Marketplace analysis (live flow) ────────────────
//
// Drop-in replacement for batchAnalyzeMarketplaceListingsWithImages: returns one
// raw JSON string per listing in input order, so scoreMarketplaceListings can
// parse/cache/score it identically. Submits one request per listing to the async
// Batch API (separate TPM pool, ~50% cost) instead of the synchronous packed call.
//
// Marketplace images are fetched + base64-embedded inside buildMarketplaceAnalysisMessages,
// so each JSONL line carries its own image data (the Facebook CDN won't serve by URL).

import { buildMarketplaceAnalysisMessages } from "./marketplaceOverview";
import { runRawChatBatch, type RawChatBatchOpts } from "./groqBatchRun";

export async function batchAnalyzeMarketplaceListingsViaBatchApi(
  listings: any[],
  context?: string | null,
  systemPrompt?: string | null,
  opts?: RawChatBatchOpts,
): Promise<string[]> {
  if (listings.length === 0) return [];

  // Image fetching is the slow part — build every listing's messages in parallel.
  const messagesList = await Promise.all(
    listings.map(async (listing) => {
      const messages = await buildMarketplaceAnalysisMessages(listing, context);
      // Prepend the group-specific system prompt (price ranges, condition signals
      // from /context) to the generic per-listing instructions when present.
      if (systemPrompt && messages[0]?.role === "system") {
        messages[0].content = `${systemPrompt}\n\n${messages[0].content}`;
      }
      return messages;
    })
  );

  // Base64 images make these requests large; give the queue a little more headroom.
  return runRawChatBatch(messagesList, "marketplace-live", { timeoutMs: 120_000, ...opts });
}
