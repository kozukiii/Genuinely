import fetch from "node-fetch";
import { mapEbaySummary } from "../utils/mapEbaySummary";
import { getEbayToken } from "./ebayToken";
import type { Listing } from "../types/listing";

const EBAY_SEARCH = "https://api.ebay.com/buy/browse/v1/item_summary/search";
const EBAY_ITEM = "https://api.ebay.com/buy/browse/v1/item";
const EBAY_RATE_LIMITS = "https://api.ebay.com/developer/analytics/v1_beta/rate_limit/";

/**
 * We keep Listing as the public contract, but we preserve extra metadata
 * (for AI + future platform parity) in a richer subtype.
 * This compiles even before you widen listing.ts.
 */
type EbayListingRich = Listing & {
  // extra optional fields your AI prompt cares about
  conditionDescriptor?: string;
  itemLocation?: string; // nice readable string
  buyingOptions?: string[];
  shippingOptions?: unknown;

  marketingPrice?: unknown;
  originalPrice?: number;
  discountPercent?: number;

  shortDescription?: string;
  description?: string;
  fullDescription?: string;

  // never lose source info
  raw?: unknown;
};

function toNumberPrice(input: any): number {
  if (typeof input === "number") return Number.isFinite(input) ? input : 0;
  if (typeof input === "string") {
    const cleaned = input.replace(/[^0-9.]/g, "");
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : 0;
  }
  if (input && typeof input === "object") {
    const v = input.value ?? input.amount ?? input.price?.value;
    return toNumberPrice(v);
  }
  return 0;
}

function toStringCurrency(input: any): string | undefined {
  if (!input) return undefined;
  if (typeof input === "string") return input;
  if (typeof input === "object")
    return input.currency ?? input.currencyCode ?? input.price?.currency;
  return undefined;
}

function formatItemLocation(loc: any): string | undefined {
  if (!loc) return undefined;

  // eBay often gives itemLocation: { city, stateOrProvince, country }
  const city = loc.city ?? loc.town ?? loc.locality;
  const state = loc.stateOrProvince ?? loc.state ?? loc.region;
  const country = loc.country ?? loc.countryName;

  const parts = [city, state, country].filter(Boolean).map(String);
  return parts.length ? parts.join(", ") : undefined;
}

function extractConditionDescriptor(item: any): string | undefined {
  // eBay sometimes has conditionDescriptor or conditionDescriptors array
  if (item?.conditionDescriptor) return String(item.conditionDescriptor);

  const arr =
    item?.conditionDescriptors ??
    item?.conditionDescriptorList ??
    item?.conditionDescriptorValues;

  if (Array.isArray(arr) && arr.length) {
    const first = arr[0];
    return typeof first === "string"
      ? first
      : first?.name
        ? String(first.name)
        : first?.description
          ? String(first.description)
          : undefined;
  }

  return undefined;
}

function extractOriginalAndDiscount(item: any) {
  // marketingPrice shapes vary; keep it defensive
  const mp = item?.marketingPrice;
  const original =
    toNumberPrice(mp?.originalPrice) ||
    toNumberPrice(mp?.originalRetailPrice) ||
    toNumberPrice(mp?.wasPrice) ||
    0;

  const discountPercent =
    typeof mp?.discountPercentage === "number"
      ? mp.discountPercentage
      : typeof mp?.discountPercent === "number"
        ? mp.discountPercent
        : 0;

  return {
    marketingPrice: mp,
    originalPrice: original > 0 ? original : undefined,
    discountPercent: discountPercent > 0 ? discountPercent : undefined,
  };
}

function mapEbayInternalToListing(item: any): EbayListingRich {
  const id = String(item.id ?? item.itemId ?? "");
  const title = String(item.title ?? item.name ?? "");
  const url = String(item.url ?? item.itemWebUrl ?? item.webUrl ?? "");

  const images: string[] = Array.isArray(item.images)
    ? item.images.filter(Boolean)
    : [item.image, ...(item.additionalImages ?? [])].filter(Boolean);

  const price =
    toNumberPrice(item.price) ||
    toNumberPrice(item.currentPrice) ||
    toNumberPrice(item?.price?.value) ||
    0;

  const currency =
    item.currency ??
    toStringCurrency(item.price) ??
    toStringCurrency(item.currentPrice) ??
    "USD";

  const conditionDescriptor = extractConditionDescriptor(item);

  // try to build a readable location string if itemLocation is present
  const itemLocation =
    formatItemLocation(item.itemLocation) ??
    (item.location ? String(item.location) : undefined);

  const { marketingPrice, originalPrice, discountPercent } =
    extractOriginalAndDiscount(item);

  const buyingOptions: string[] | undefined = Array.isArray(item.buyingOptions)
    ? item.buyingOptions.map(String)
    : undefined;

  const shippingOptions: unknown =
    item.shippingOptions ?? item.shippingOption ?? undefined;

  const shortDescription =
    item.shortDescription ??
    item.subtitle ??
    item.short_description ??
    undefined;

  return {
    // --- required contract ---
    id,
    source: "ebay",
    title,
    price,
    currency,
    condition: item.condition ? String(item.condition) : undefined,
    url,
    images,

    // --- common extras ---
    seller: item.seller ?? item.sellerUsername ?? undefined,
    feedback: item.feedback ?? item.sellerFeedback ?? undefined,
    shippingPrice: (() => {
      // Explicit fields first
      const explicit = item.shippingPrice ?? item.shippingCost ?? item.shipping?.shippingCost;
      if (explicit != null) return toNumberPrice(explicit);

      // eBay Browse API stores shipping as shippingOptions[].shippingCost
      const opts = item.shippingOptions ?? item.shippingOption;
      if (Array.isArray(opts) && opts.length > 0) {
        // FREE shipping eBay explicitly marks with type "FREE" or a zero-value cost
        const isFree = opts.some(
          (o: any) =>
            String(o.shippingCostType ?? o.type ?? "").toUpperCase() === "FREE" ||
            (o.shippingCost != null && toNumberPrice(o.shippingCost) === 0)
        );
        if (isFree) return 0;

        // Calculated shipping with no resolved cost — only skip if cost is still absent
        const isUnresolvedCalculated = opts.some(
          (o: any) =>
            String(o.shippingCostType ?? "").toUpperCase() === "CALCULATED" &&
            o.shippingCost == null
        );
        if (isUnresolvedCalculated) return undefined;

        // Otherwise take the lowest shipping cost offered
        const costs = opts
          .map((o: any) => toNumberPrice(o.shippingCost))
          .filter((n: number) => n > 0);
        if (costs.length > 0) return Math.min(...costs);
      }

      // No shipping info at all — leave undefined so UI hides the field
      return undefined;
    })(),
    location: itemLocation, // keep your existing field populated
    score: item.score ?? undefined,

    // --- richer fields for AI + future ---
    conditionDescriptor,
    itemLocation,
    buyingOptions,
    shippingOptions,
    marketingPrice,
    originalPrice,
    discountPercent,
    shortDescription,
    description: item.description ?? undefined,
    fullDescription: item.fullDescription ?? undefined,

    // --- AI fields empty here; aiService fills when analyze=1 ---
    aiScore: undefined,
    aiScores: undefined,
    overview: undefined,
    debugInfo: undefined,
    rawAnalysis: undefined,

    // --- never lose source payload ---
    raw: item,
  };
}

export async function getEbayItemsWithDetails(
  query: string,
  limit: number = 8,
  buyerLocation?: { country: string; zip: string } | null,
  minPrice?: number,
  maxPrice?: number,
  sortBy?: "price_asc" | "price_desc",
  offset = 0
) {
  const token = await getEbayToken();

  const ebayHeaders: Record<string, string> = { Authorization: `Bearer ${token}` };
  const currency = buyerLocation?.country === "GB" ? "GBP"
    : buyerLocation?.country === "CA" ? "CAD"
    : buyerLocation?.country === "AU" ? "AUD"
    : "USD";

  if (buyerLocation?.country) {
    const parts = [`country=${buyerLocation.country}`];
    if (buyerLocation.zip) parts.push(`zip=${buyerLocation.zip}`);
    ebayHeaders["X-EBAY-C-ENDUSERCTX"] = `contextualLocation=${parts.join(",")}`;
  }

  let searchUrl = `${EBAY_SEARCH}?q=${encodeURIComponent(query)}&limit=${limit}`;
  if (minPrice != null || maxPrice != null) {
    const lo = minPrice != null ? minPrice : "";
    const hi = maxPrice != null ? maxPrice : "";
    searchUrl += `&filter=${encodeURIComponent(`price:[${lo}..${hi}],priceCurrency:${currency}`)}`;
  }
  if (sortBy === "price_asc") searchUrl += "&sort=price";
  else if (sortBy === "price_desc") searchUrl += "&sort=-price";
  if (offset > 0) searchUrl += `&offset=${offset}`;

  const searchRes = await fetch(searchUrl, { headers: ebayHeaders });

  if (!searchRes.ok) {
    const body = await searchRes.text().catch(() => "");
    throw new Error(
      `eBay search failed: HTTP ${searchRes.status} ${searchRes.statusText} | ${body.slice(0, 200)}`
    );
  }

  const searchJson: any = await searchRes.json();
  const summariesRaw = searchJson.itemSummaries || [];

  if (!Array.isArray(summariesRaw) || summariesRaw.length === 0) {
    return [];
  }

  const summaries = summariesRaw.map(mapEbaySummary);

  const detailedItems = await Promise.all(
    summaries.map(async (summary: any) => {
      const fullRes = await fetch(`${EBAY_ITEM}/${summary.id}`, {
        headers: ebayHeaders,
      });

      // If one item fails, don’t kill the whole request
      if (!fullRes.ok) return summary;

      const fullJson: any = await fullRes.json().catch(() => ({}));

      // Pull ONLY the fields you care about (not the whole blob)
      const description = fullJson.description || summary.description || "";

      return {
        ...summary,

        // description + images
        fullDescription: description,
        images: [summary.image, ...(summary.additionalImages ?? [])].filter(Boolean),

        // preserve extra fields for AI if present on item endpoint
        buyingOptions: fullJson.buyingOptions ?? summary.buyingOptions,
        shippingOptions: fullJson.shippingOptions ?? summary.shippingOptions,
        marketingPrice: fullJson.marketingPrice ?? summary.marketingPrice,
        itemLocation: fullJson.itemLocation ?? summary.itemLocation,
        conditionDescriptor:
          fullJson.conditionDescriptor ??
          summary.conditionDescriptor ??
          (Array.isArray(fullJson.conditionDescriptors) ? fullJson.conditionDescriptors : undefined) ??
          (Array.isArray(summary.conditionDescriptors) ? summary.conditionDescriptors : undefined),

        shortDescription: fullJson.shortDescription ?? summary.shortDescription,
      };
    })
  );

  return detailedItems;
}

// ✅ Used by /api/search aggregator
export async function searchEbayNormalized(
  query: string,
  limit: number = 1,
  buyerLocation?: { country: string; zip: string } | null,
  minPrice?: number,
  maxPrice?: number,
  sortBy?: "price_asc" | "price_desc",
  offset = 0
): Promise<Listing[]> {
  const items = await getEbayItemsWithDetails(query, limit, buyerLocation, minPrice, maxPrice, sortBy, offset);
  return items
    .map(mapEbayInternalToListing)
    .filter((l) => l.id && l.title && l.url);
}

export async function getEbayItemByNumericId(
  numericId: string,
  buyerLocation?: { country: string; zip: string } | null
): Promise<Listing> {
  const token = await getEbayToken();
  const ebayId = `v1|${numericId}|0`;

  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (buyerLocation?.country) {
    const parts = [`country=${buyerLocation.country}`];
    if (buyerLocation.zip) parts.push(`zip=${buyerLocation.zip}`);
    headers["X-EBAY-C-ENDUSERCTX"] = `contextualLocation=${parts.join(",")}`;
  }

  const res = await fetch(`${EBAY_ITEM}/${ebayId}`, { headers });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`eBay item fetch failed: HTTP ${res.status} | ${body.slice(0, 200)}`);
  }

  const item: any = await res.json();

  const images: string[] = [
    item.image?.imageUrl,
    ...(item.additionalImages?.map((i: any) => i?.imageUrl) ?? []),
  ].filter(Boolean);

  const merged = {
    ...item,
    id: item.itemId ?? ebayId,
    url: item.itemWebUrl ?? `https://www.ebay.com/itm/${numericId}`,
    images,
    seller: item.seller?.username,
    feedback: item.seller?.feedbackPercentage,
    score: item.seller?.feedbackScore,
    fullDescription: item.description ?? "",
  };

  return mapEbayInternalToListing(merged);
}

export async function getEbayRateLimits() {
  const token = await getEbayToken();

  const res = await fetch(EBAY_RATE_LIMITS, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `eBay getRateLimits failed: HTTP ${res.status} ${res.statusText} | ${body.slice(0, 500)}`
    );
  }

  return res.json();
}
