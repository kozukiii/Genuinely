import { analyzeItemsWithAI } from "../aiService";

export async function scoreEbayListing(listing: any, context?: string | null) {
  const [scored] = await analyzeItemsWithAI([listing], context);
  return scored ?? listing;
}