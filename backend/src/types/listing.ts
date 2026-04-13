export type ListingSource = "ebay" | "marketplace";

export interface Listing {
  // --- REQUIRED (card + routing) ---
  id: string;
  source: ListingSource;
  title: string;

  // Normalize price to a NUMBER so sorting/scoring is sane (formatting happens in UI).
  // null means the price data was unavailable (e.g. a cross-platform partner listing) —
  // distinct from 0 which means "Accepts Offers" on Facebook Marketplace.
  price: number | null;
  currency?: string; // "USD" etc.

  url: string;

  // always normalized to array (can be empty)
  images: string[];

  // --- COMMON OPTIONAL FIELDS (varies by platform) ---
  seller?: string;

  // keep it flexible: "99.6" OR "100.0% (2 ratings)"
  feedback?: string;

  condition?: string;
  conditionDescriptor?: string;

  // nice readable string like "Eau Claire, WI, US"
  itemLocation?: string;

  // you already use this; keep it
  location?: string;

  // ebay-ish
  shippingPrice?: number;
  shippingCalculated?: boolean; // true when eBay uses calculated shipping (no resolved amount)
  shippingEstimated?: boolean;  // true when shippingPrice was estimated via weight lookup
  shippingOptions?: unknown;
  buyingOptions?: string[];

  // pricing metadata (optional)
  marketingPrice?: unknown;
  originalPrice?: number;
  discountPercent?: number;

  // descriptions (optional)
  shortDescription?: string;
  description?: string;
  fullDescription?: string;

  // source ranking / score fields (optional)
  score?: number;

  // true when price is 0 (listing uses negotiated/offer-based pricing)
  acceptsOffers?: boolean;

  // --- AI scoring (optional; only present when analyze=1) ---
  aiScore?: number;
  aiScores?: {
    priceFairness?: number;
    sellerTrust?: number;
    conditionHonesty?: number;
    shippingFairness?: number;
    locationRisk?: number;
    descriptionQuality?: number;
  };

  overview?: string;
  debugInfo?: string;
  rawAnalysis?: string;
  marketContext?: string;

  // Market price range from context analysis
  priceLow?: number;
  priceHigh?: number;

  // --- “never lose data” escape hatch ---
  raw?: unknown;

  // Set when a Facebook Marketplace listing is actually an eBay cross-listing.
  // The from-url route will resolve this to an eBay listing instead.
  crossListedEbayId?: string;

  // backwards compat if anything still uses `link`
  link?: string;
}
