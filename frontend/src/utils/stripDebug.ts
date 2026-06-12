import type { Listing } from "../types/Listing";

// `debugVisionImages` carries the base64 images sent to the vision model (~1-2MB
// per marketplace listing). It's for in-memory debug display only and must be
// stripped before anything is written to localStorage/sessionStorage, or it will
// blow the storage quota. Apply at every storage choke point.
export function stripVisionDebug(listing: Listing): Listing {
  if (!listing.debugVisionImages) return listing;
  const { debugVisionImages, ...rest } = listing;
  return rest;
}

export function stripVisionDebugAll(listings: Listing[]): Listing[] {
  return listings.map(stripVisionDebug);
}
