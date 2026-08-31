// Marketplace scoring through bounded concurrent Groq Chat Completions.
// Images are fetched server-side because Facebook CDN URLs require auth/cookies.

import { buildMarketplaceAnalysisMessages } from "./marketplaceOverview";
import { runRawChatRequests, type RawChatRequestOpts } from "./groqBatchRun";

export async function analyzeMarketplaceListingsViaChat(
  listings: any[],
  context?: string | null,
  systemPrompt?: string | null,
  opts?: RawChatRequestOpts,
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

  return runRawChatRequests(messagesList, "marketplace-live", {
    ...opts,
    schema: "marketplace-single",
  });
}
