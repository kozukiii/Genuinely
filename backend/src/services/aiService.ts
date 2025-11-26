import { analyzeListingWithImage } from "../ai/ebayOverview";

// Analyze a single item
export async function analyzeItemWithAI(merged: any) {
  const analysis = await analyzeListingWithImage({
    title: merged.title,
    price: merged.price,
    currency: merged.currency,
    link: merged.url,

    // Seller info (still comes from summary)
    seller: merged.seller,
    feedback: merged.feedback,
    score: merged.score,

    condition: merged.condition,
    conditionDescriptor: merged.conditionDescriptor,

    // Location (summary includes this if eBay provides it)
    itemLocation: merged.itemLocation,

    // Only summary-level fields remain
    buyingOptions: merged.buyingOptions,
    shippingOptions: merged.shippingOptions, // summary has some

    // Summary-level price promos (sometimes included)
    marketingPrice: merged.marketingPrice,

    // Our new optimized description
    description: merged.fullDescription || merged.description,

    // Images (summary only)
    imageUrl: merged.allImages
  });

  // Extract the AI rating (0–100)
  let aiScore: number | null = null;
  const match = analysis.match(/(\d{1,3})\s*\/\s*100/);
  if (match) aiScore = Math.max(0, Math.min(100, parseInt(match[1])));

  return {
    aiScore,
    overview: analysis
  };
}

// Analyze an array of items
export async function analyzeItemsWithAI(items: any[]) {
  const analyzed = await Promise.all(
    items.map(async (item) => {
      const ai = await analyzeItemWithAI(item);
      return { ...item, ...ai };
    })
  );

  return analyzed;
}
