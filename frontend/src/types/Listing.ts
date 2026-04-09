export type ListingSource = "ebay" | "marketplace";

export interface Listing {
  id: string;

  // where it came from
  source: ListingSource;

  title: string;

  // null = price unavailable (cross-platform partner listing); 0 = Accepts Offers
  price: number | null;

  currency?: string; // "USD" etc.

  condition?: string;

  url: string;

  // normalize naming (but keep backwards-compat support in code for now)
  images: string[];

  // optional metadata (varies by source)
  seller?: string;
  feedback?: string; // keep string if you want "99.6" etc
  score?: number;

  location?: string;       // marketplace commonly provides
  shippingPrice?: number;  // ebay commonly provides
  shippingCalculated?: boolean; // true when eBay uses calculated shipping (no resolved amount)
  description?: string;
  fullDescription?: string;

  // true when price is 0 (listing uses negotiated/offer-based pricing)
  acceptsOffers?: boolean;

  // AI scoring
  analysisPending?: boolean; // true while background analysis pipeline is running
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
  systemPrompt?: string;

  // Market price range from context analysis
  priceLow?: number;
  priceHigh?: number;

  // Set when a Marketplace listing was resolved to an eBay cross-listing
  crossListedEbayId?: string;
}
