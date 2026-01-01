import { marketplaceRequest } from "../utils/marketplaceApiClient";

// You can align this with your frontend Listing shape
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
    // remove $, commas, etc.
    const cleaned = input.replace(/[^0-9.]/g, "");
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

// TODO: replace this mapping once you paste marketplaceApiClient.ts response shape
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

export async function searchMarketplace(query: string, limit = 12): Promise<MarketplaceListing[]> {
  const res = await marketplaceRequest("/search", { q: query, limit });

  const items: any[] = Array.isArray(res?.items) ? res.items
    : Array.isArray(res?.results) ? res.results
    : Array.isArray(res) ? res
    : [];

  return items.map(mapMarketplaceItem).filter(x => x.url && x.title);
}
