import type { Listing } from "../types/Listing";

export function hasEbayCustomizableOptions(listing: Pick<Listing, "source" | "itemGroupId" | "id">): boolean {
  if (listing.source !== "ebay") return false;
  if (listing.itemGroupId) return true;
  return /^v1\|\d+\|[1-9]\d*$/.test(String(listing.id ?? ""));
}
