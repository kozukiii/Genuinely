import { scoreEbayListing } from "./scoreEbayListing";
import { scoreMarketplaceListing } from "./scoreMarketplaceListing";

export async function scoreListing(listing: any) {
  switch (listing.source) {
    case "ebay":
      return scoreEbayListing(listing);
    case "marketplace":
      return scoreMarketplaceListing(listing);
    default:
      return listing;
  }
}

export async function scoreListings(listings: any[]) {
  return Promise.all(listings.map(scoreListing));
}