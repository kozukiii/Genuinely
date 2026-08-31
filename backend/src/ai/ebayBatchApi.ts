import { buildEbayAnalysisMessages } from "./ebayOverview";
import { runRawChatRequests, type RawChatRequestOpts } from "./groqBatchRun";

/** Score eBay listings through bounded concurrent Groq chat completions. */
export async function analyzeEbayListingsViaChat(
  listings: any[],
  context?: string | null,
  systemPrompt?: string | null,
  opts?: RawChatRequestOpts,
): Promise<string[]> {
  if (listings.length === 0) return [];

  const messagesList = await Promise.all(listings.map(async (listing) => {
    const messages = await buildEbayAnalysisMessages(listing, context);
    if (systemPrompt && messages[0]?.role === "system") {
      messages[0].content = `${systemPrompt}\n\n${messages[0].content}`;
    }
    return messages;
  }));

  return runRawChatRequests(messagesList, "ebay-live", {
    ...opts,
    schema: "ebay-single",
  });
}
