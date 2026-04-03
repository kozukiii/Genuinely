import { scoreEbayListing } from "./scoreEbayListing";
import { scoreMarketplaceListing, scoreMarketplaceListings } from "./scoreMarketplaceListing";
import { analyzeItemsWithAI } from "../aiService";

export async function scoreListing(listing: any, context?: string | null) {
  switch (listing.source) {
    case "ebay":
      return scoreEbayListing(listing, context);
    case "marketplace":
      return scoreMarketplaceListing(listing, context);
    default:
      return listing;
  }
}

export async function scoreListings(listings: any[], context?: string | null) {
  const ebay = listings.filter((l) => l.source === "ebay");
  const marketplace = listings.filter((l) => l.source === "marketplace");
  const other = listings.filter((l) => l.source !== "ebay" && l.source !== "marketplace");

  const [scoredEbay, scoredMarketplace] = await Promise.all([
    analyzeItemsWithAI(ebay, context),
    scoreMarketplaceListings(marketplace, context),
  ]);

  // Restore original order
  const byKey = new Map<string, any>();
  [...scoredEbay, ...scoredMarketplace, ...other].forEach((item) =>
    byKey.set(`${item.source}:${item.id}`, item)
  );

  return listings.map((l) => byKey.get(`${l.source}:${l.id}`) ?? l);
}