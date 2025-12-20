export interface Listing {
  id: string;
  title: string;
  price: string;
  condition: string;
  url: string;
  image?: string;
  images?: string[];
  seller?: string;
  feedback?: string;
  score?: number;

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

  overview?: string;     // Summary reasoning only
  debugInfo?: string;    // Debug info block
  rawAnalysis?: string;  // Full AI output for dev
}
