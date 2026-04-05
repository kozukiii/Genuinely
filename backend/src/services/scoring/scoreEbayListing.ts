import { analyzeItemsWithAI } from "../aiService";

export async function scoreEbayListing(listing: any, context?: string | null, systemPrompt?: string | null) {
  const [scored] = await analyzeItemsWithAI([listing], context, systemPrompt);
  return scored ?? listing;
}