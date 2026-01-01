import { analyzeListingWithImages } from "../ai/ebayOverview";

// Helper for safe average
function average(nums: number[]) {
  const valid = nums.filter((n) => typeof n === "number" && !isNaN(n));
  if (valid.length === 0) return null;
  return Math.round(valid.reduce((a, b) => a + b, 0) / valid.length);
}

export async function analyzeItemWithAI(merged: any) {
  // Normalize image input
  const images: string[] =
    Array.isArray(merged.images) ? merged.images :
    Array.isArray(merged.imageUrls) ? merged.imageUrls :
    [];

  const imageUrls = images.filter(Boolean);
const imageUrl = imageUrls[0] ?? "";



  const analysis = await analyzeListingWithImages({
    title: merged.title,
    price: merged.price,
    currency: merged.currency ?? "USD",
    link: merged.link ?? merged.url,


    // optional — present on eBay, usually absent on marketplace
    seller: merged.seller,
    feedback: merged.feedback,
    score: merged.score,

    condition: merged.condition,
    conditionDescriptor: merged.conditionDescriptor,

    buyingOptions: merged.buyingOptions,
    shippingOptions: merged.shippingOptions,
    shippingPrice: merged.shippingPrice,     // add if your prompt supports it
    location: merged.location,               // add if your prompt supports it

    marketingPrice: merged.marketingPrice,

    description: merged.fullDescription || merged.description || "",

    // IMPORTANT: pass ONE image unless your prompt expects multiple
    imageUrl,
    imageUrls
  });

  // Extract JSON block ONLY (top section)
  let jsonBlock: any = null;

  try {
    const jsonMatch = analysis.match(/^\s*\{[\s\S]*?\}\s*(?=DEBUG INFO:)/);

    if (jsonMatch) {
      jsonBlock = JSON.parse(jsonMatch[0]);
    } else {
      console.error("⚠ No JSON block found in AI response.");
      console.log("RAW:", analysis);
    }
  } catch (err) {
    console.error("Failed to parse AI JSON:", err);
    console.log("RAW ANALYSIS:", analysis);
  }

  const scores = jsonBlock?.scores || {};

  const {
    priceFairness,
    sellerTrust,
    conditionHonesty,
    shippingFairness,
    locationRisk,
    descriptionQuality,
  } = scores;

  const aiScore = average([
    priceFairness,
    sellerTrust,
    conditionHonesty,
    shippingFairness,
    locationRisk,
    descriptionQuality,
  ]);

  return {
    aiScore,
    aiScores: scores,
    overview: jsonBlock?.overview || "No overview.",
    debugInfo: analysis.split("DEBUG INFO:")[1]?.trim() || "No debug info.",
    rawAnalysis: analysis,
  };
}

export async function analyzeItemsWithAI(items: any[]) {
  const analyzed = await Promise.all(
    items.map(async (item) => {
      const ai = await analyzeItemWithAI(item);
      return {
        ...item,
        ...ai,
      };
    })
  );

  return analyzed;
}
