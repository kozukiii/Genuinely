import fetch from "node-fetch";
import { mapEbaySummary } from "../utils/mapEbaySummary";
import { getEbayToken } from "./ebayToken";
import type { Listing } from "../types/listing";

const EBAY_SEARCH = "https://api.ebay.com/buy/browse/v1/item_summary/search";
const EBAY_ITEM = "https://api.ebay.com/buy/browse/v1/item";

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
            toNumberPrice(o.shippingCost) === 0
        );
        if (isFree) return 0;

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

export async function getEbayItemsWithDetails(query: string, limit: number = 8) {
  const token = await getEbayToken();

  const searchRes = await fetch(
    `${EBAY_SEARCH}?q=${encodeURIComponent(query)}&limit=${limit}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

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
        headers: { Authorization: `Bearer ${token}` },
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
  limit: number = 1
): Promise<Listing[]> {
  try {
    const items = await getEbayItemsWithDetails(query, limit);
    return items
      .map(mapEbayInternalToListing)
      .filter((l) => l.id && l.title && l.url);
  } catch (err) {
    console.error("searchEbayNormalized failed", err);
    return [];
  }
}
