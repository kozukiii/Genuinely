import { marketplaceRequest } from "../utils/marketplaceApiClient";
import type { Listing } from "../types/listing"; // matches your backend types file name

// Keep this if other code still imports MarketplaceListing
export type ListingSource = "marketplace";

export interface MarketplaceListing {
  id: string;
  source: ListingSource;

  title: string;
  price: number;
  currency: string;

  condition?: string;
  url: string;
  images: string[];

  seller?: string;
  location?: string;
}

function toNumberPrice(input: any): number {
  if (typeof input === "number") return input;
  if (typeof input === "string") {
    const cleaned = input.replace(/[^0-9.]/g, "");
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

// TODO: replace this mapping once marketplaceApiClient.ts response shape is finalized
function mapMarketplaceItem(raw: any): MarketplaceListing {
  return {
    id: String(raw.id ?? raw.listing_id ?? raw.itemId),
    source: "marketplace",

    title: String(raw.title ?? raw.name ?? "Untitled"),
    price: toNumberPrice(raw.price ?? raw.amount ?? raw.list_price),
    currency: String(raw.currency ?? "USD"),

    condition: raw.condition ? String(raw.condition) : undefined,

    url: String(raw.url ?? raw.permalink ?? raw.link ?? ""),
    images: Array.isArray(raw.images)
      ? raw.images.map((x: any) => (typeof x === "string" ? x : x?.url)).filter(Boolean)
      : Array.isArray(raw.imageUrls)
        ? raw.imageUrls
        : raw.primaryImage
          ? [raw.primaryImage]
          : [],

    seller: raw.seller?.name ?? raw.seller_name,
    location: raw.location?.city ?? raw.location_name ?? raw.location,
  };
}

// Existing function (keep it so other imports don’t break)
export async function searchMarketplace(query: string, limit = 12): Promise<MarketplaceListing[]> {
  try {
    const res = await marketplaceRequest("/search", { q: query, limit });

    const items: any[] = Array.isArray(res?.items) ? res.items
      : Array.isArray(res?.results) ? res.results
      : Array.isArray(res) ? res
      : [];

    return items.map(mapMarketplaceItem).filter(x => x.url && x.title);
  } catch {
    // Critical for aggregator fallback: marketplace failures should not crash the request
    return [];
  }
}

// Normalized wrapper for the future /api/search aggregator
export async function searchMarketplaceNormalized(query: string, limit = 12): Promise<Listing[]> {
  const items = await searchMarketplace(query, limit);

  // Convert MarketplaceListing -> normalized Listing contract
  return items.map((x) => ({
    id: x.id,
    source: "marketplace",
    title: x.title,
    price: x.price,
    currency: x.currency,
    condition: x.condition,
    url: x.url,
    images: x.images ?? [],
    seller: x.seller,
    location: x.location,

    // leave ebay-ish fields undefined
    shippingPrice: undefined,

    // leave AI fields undefined (demo mode / no-token mode)
    aiScore: undefined,
    aiScores: undefined,
    overview: undefined,
    debugInfo: undefined,
    rawAnalysis: undefined,
  }));
}
