import { scoreEbayListing } from "./scoreEbayListing";
import { scoreMarketplaceListing, scoreMarketplaceListings } from "./scoreMarketplaceListing";
import { analyzeItemsWithAI } from "../aiService";

export async function scoreListing(listing: any, context?: string | null, systemPrompt?: string | null) {
  switch (listing.source) {
    case "ebay":
      return scoreEbayListing(listing, context, systemPrompt);
    case "marketplace":
      return scoreMarketplaceListing(listing, context, systemPrompt);
    default:
      return listing;
  }
}

export async function scoreListings(listings: any[], context?: string | null, systemPrompt?: string | null) {
  const ebay = listings.filter((l) => l.source === "ebay");
  const marketplace = listings.filter((l) => l.source === "marketplace");
  const other = listings.filter((l) => l.source !== "ebay" && l.source !== "marketplace");

  const [scoredEbay, scoredMarketplace] = await Promise.all([
    analyzeItemsWithAI(ebay, context, systemPrompt),
    scoreMarketplaceListings(marketplace, context, systemPrompt),
  ]);

  // Restore original order
  const byKey = new Map<string, any>();
  [...scoredEbay, ...scoredMarketplace, ...other].forEach((item) =>
    byKey.set(`${item.source}:${item.id}`, item)
  );

  return listings.map((l) => byKey.get(`${l.source}:${l.id}`) ?? l);
}
