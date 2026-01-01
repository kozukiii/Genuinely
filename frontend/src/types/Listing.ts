export type ListingSource = "ebay" | "marketplace";

export interface Listing {
  id: string;

  // where it came from
  source: ListingSource;

  title: string;

  // Normalize price to a NUMBER so sorting/scoring is sane
  // (formatting happens in UI)
  price: number;

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

  // AI scoring
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
}
