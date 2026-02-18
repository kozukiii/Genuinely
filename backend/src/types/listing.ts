export type ListingSource = "ebay" | "marketplace";

export interface Listing {
  // --- REQUIRED (card + routing) ---
  id: string;
  source: ListingSource;
  title: string;

  // Normalize price to a NUMBER so sorting/scoring is sane
  // (formatting happens in UI)
  price: number;
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

  // --- “never lose data” escape hatch ---
  raw?: unknown;

  // backwards compat if anything still uses `link`
  link?: string;
}
