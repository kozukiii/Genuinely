import { analyzeListingsWithImages } from "../ai/ebayOverview";

type ListingForAnalysis = {
  id: string;
  title: string;
  price: string | number;
  currency: string;
  link: string;

  seller?: string;
  feedback?: string;
  score?: string;

  condition?: string;
  conditionDescriptor?: string;

  itemLocation?: {
    city?: string;
    stateOrProvince?: string;
    country?: string;
  };

  buyingOptions?: string[];
  shippingOptions?: any[];
  marketingPrice?: {
    originalPrice?: string | number;
    discountPercentage?: string | number;
  };

  description?: string;
  fullDescription?: string;

  imageUrl?: string | string[];
};

type ListingAnalysisResult = {
  id: string;
  rating?: number;
  reason?: string;
  debugInfo?: Record<string, unknown>;
};

function buildListingPayload(merged: any, index: number): ListingForAnalysis {
  const listingId = merged.id || merged.itemId || merged.url || `listing-${index}`;

  return {
    id: String(listingId),
    title: merged.title,
    price: merged.price,
    currency: merged.currency,
    link: merged.url,

    seller: merged.seller,
    feedback: merged.feedback,
    score: merged.score,

    condition: merged.condition,
    conditionDescriptor: merged.conditionDescriptor,

    itemLocation: merged.itemLocation,

    buyingOptions: merged.buyingOptions,
    shippingOptions: merged.shippingOptions,
    marketingPrice: merged.marketingPrice,

    description: merged.description,
    fullDescription: merged.fullDescription,

    imageUrl: merged.allImages,
  };
}

function formatOverview(result?: ListingAnalysisResult) {
  if (!result) return "No analysis.";

  const debugInfo = result.debugInfo ? JSON.stringify(result.debugInfo, null, 2) : "";
  return `${result.rating ?? "N/A"}/100 ${result.reason || "No reasoning provided."}\n\nDEBUG INFO:\n${debugInfo}`;
}

// Analyze a single item
export async function analyzeItemWithAI(merged: any) {
  const [analysis] = await analyzeListingsWithImages([
    buildListingPayload(merged, 0),
  ]);

  const aiScore =
    typeof analysis?.rating === "number"
      ? Math.max(0, Math.min(100, analysis.rating))
      : null;

  return {
    aiScore,
    overview: formatOverview(analysis),
  };
}

// Analyze an array of items
export async function analyzeItemsWithAI(items: any[]) {
  const listings = items.map((item, index) => buildListingPayload(item, index));

  const analyzed: ListingAnalysisResult[] = [];
  const batchSize = 8;

  for (let i = 0; i < listings.length; i += batchSize) {
    const batch = listings.slice(i, i + batchSize);
    const results = await analyzeListingsWithImages(batch);
    analyzed.push(...results);
  }

  const resultsMap = analyzed.reduce<Map<string, ListingAnalysisResult>>((map, result) => {
    map.set(result.id, result);
    return map;
  }, new Map());

  return items.map((item, index) => {
    const listingId = listings[index]?.id;
    const aiResult = listingId ? resultsMap.get(listingId) : undefined;

    const aiScore =
      typeof aiResult?.rating === "number"
        ? Math.max(0, Math.min(100, aiResult.rating))
        : null;

    return {
      ...item,
      aiScore,
      overview: formatOverview(aiResult),
    };
  });
}
