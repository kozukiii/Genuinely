import type { Listing } from "../types/listing";
import { getEbayItemByEbayId, getEbayItemByNumericId } from "./ebayService";
import { getMarketplaceListingByGraphqlForAnalysis } from "./marketplaceService";

export type ListingAvailabilityStatus = "active" | "sold" | "ended" | "removed" | "unknown";

type ListingWithHealth = Listing & {
  availabilityStatus?: ListingAvailabilityStatus;
  availabilityCheckedAt?: string;
  availabilityReason?: string;
  lastSeenActiveAt?: string;
  endedAt?: string;
  analysisSkipped?: boolean;
};

const ACTIVE_TTL_MS = 60 * 60 * 1000;
const UNKNOWN_TTL_MS = 30 * 60 * 1000;
const INACTIVE_TTL_MS = 6 * 60 * 60 * 1000;

function inactive(status: unknown): boolean {
  return status === "sold" || status === "ended" || status === "removed";
}

export function isInactiveAvailability(status: unknown): boolean {
  return inactive(status);
}

function checkedAtMs(listing: Record<string, unknown>): number | null {
  const raw = listing.availabilityCheckedAt;
  if (typeof raw !== "string") return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

export function listingNeedsAvailabilityCheck(
  listing: Record<string, unknown>,
  options: { force?: boolean; now?: number } = {},
): boolean {
  if (options.force) return true;
  if (!listing.id || !listing.source) return false;

  const checked = checkedAtMs(listing);
  if (checked == null) return true;

  const status = listing.availabilityStatus;
  const ttl = inactive(status)
    ? INACTIVE_TTL_MS
    : status === "unknown"
      ? UNKNOWN_TTL_MS
      : ACTIVE_TTL_MS;

  return (options.now ?? Date.now()) - checked > ttl;
}

function extractEbayNumericId(listing: Record<string, any>): string | null {
  const candidates = [listing.id, listing.url, listing.link].filter(Boolean).map(String);
  for (const value of candidates) {
    const pipeMatch = value.match(/\|(\d{8,})\|/);
    if (pipeMatch) return pipeMatch[1];

    const urlMatch = value.match(/\/itm\/(?:[^/?#]+\/)?(\d{8,})/i);
    if (urlMatch) return urlMatch[1];

    if (/^\d{8,}$/.test(value)) return value;
  }
  return null;
}

function marketplaceIsSold(raw: any): boolean {
  return raw?.is_sold === true
    || raw?.isSold === true
    || raw?.is_sold_listing === true
    || raw?.availability?.is_sold === true;
}

function patchAvailability<T extends Record<string, any>>(
  listing: T,
  status: ListingAvailabilityStatus,
  reason: string,
  checkedAt: string,
): T & ListingWithHealth {
  const patch: Partial<ListingWithHealth> = {
    availabilityStatus: status,
    availabilityCheckedAt: checkedAt,
    availabilityReason: reason,
  };

  if (status === "active") {
    patch.lastSeenActiveAt = checkedAt;
    patch.endedAt = undefined;
  } else if (inactive(status) && !listing.endedAt) {
    patch.endedAt = checkedAt;
  }

  return { ...listing, ...patch } as T & ListingWithHealth;
}

function markReachable<T extends Record<string, any>>(
  original: T,
  checkedAt: string,
): T & ListingWithHealth {
  // Health check is a reachability probe only — never merge re-fetched data
  // over the saved listing, or we clobber stored analysis fields (score, etc).
  return patchAvailability(original, "active", "Source listing was reachable.", checkedAt);
}

export async function refreshListingAvailability<T extends Record<string, any>>(
  listing: T,
  options: { force?: boolean; now?: number } = {},
): Promise<T & ListingWithHealth> {
  if (!listingNeedsAvailabilityCheck(listing, options)) {
    return listing as T & ListingWithHealth;
  }

  const checkedAt = new Date(options.now ?? Date.now()).toISOString();

  if (listing.source === "ebay") {
    const numericId = extractEbayNumericId(listing);
    if (!numericId) {
      return patchAvailability(listing, "unknown", "Could not read the eBay item id.", checkedAt);
    }

    // For variation listings the stored ID is already "v1|parentId|variantId".
    // Fetching the parent with "|0" returns 404 on eBay's side for these listings,
    // which incorrectly marks them as ended. Use the stored variant ID directly.
    const storedId = String(listing.id ?? "");
    const isVariantId = /^v1\|\d+\|[1-9]\d*$/.test(storedId);

    try {
      const fresh = isVariantId
        ? await getEbayItemByEbayId(storedId, null)
        : await getEbayItemByNumericId(numericId, null);
      void fresh;
      return markReachable(listing, checkedAt);
    } catch (err: any) {
      const message = err?.message ?? String(err);
      const status = /HTTP\s+(404|410)\b|not found|not available|unavailable/i.test(message)
        ? "ended"
        : "unknown";
      return patchAvailability(listing, status, message, checkedAt);
    }
  }

  if (listing.source === "marketplace") {
    try {
      const fresh = await getMarketplaceListingByGraphqlForAnalysis(String(listing.id));
      if (marketplaceIsSold((fresh as any).raw)) {
        return patchAvailability(listing, "sold", "Marketplace marks this listing as sold.", checkedAt);
      }
      return markReachable(listing, checkedAt);
    } catch (err: any) {
      const message = err?.message ?? String(err);
      const status = /unavailable|could not be retrieved|HTTP\s+(404|410)\b/i.test(message)
        ? "removed"
        : "unknown";
      return patchAvailability(listing, status, message, checkedAt);
    }
  }

  return patchAvailability(listing, "unknown", "Unsupported listing source.", checkedAt);
}

export async function refreshListingsAvailability<T extends Record<string, any>>(
  listings: T[],
  options: { force?: boolean; maxChecks?: number } = {},
): Promise<(T & ListingWithHealth)[]> {
  const maxChecks = Math.max(0, options.maxChecks ?? 24);
  let checksRemaining = maxChecks;

  const jobs = listings.map((listing) => {
    const shouldCheck = checksRemaining > 0 && listingNeedsAvailabilityCheck(listing, { force: options.force });
    if (shouldCheck) checksRemaining -= 1;
    return shouldCheck
      ? refreshListingAvailability(listing, { force: options.force })
      : Promise.resolve(listing as T & ListingWithHealth);
  });

  return Promise.all(jobs);
}
