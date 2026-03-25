import { analyzeItemsWithAI } from "../aiService";

export async function scoreEbayListing(listing: any) {
  const [scored] = await analyzeItemsWithAI([listing]);
  return scored ?? listing;
}