import { analyzeListingWithImage } from "../ai/ebayOverview";

// Helper for safe average
function average(nums: number[]) {
  const valid = nums.filter(n => typeof n === "number" && !isNaN(n));
  if (valid.length === 0) return null;
  return Math.round(valid.reduce((a, b) => a + b, 0) / valid.length);
}

export async function analyzeItemWithAI(merged: any) {
  const analysis = await analyzeListingWithImage({
    title: merged.title,
    price: merged.price,
    currency: merged.currency,
    link: merged.url,

    seller: merged.seller,
    feedback: merged.feedback,
    score: merged.score,

    condition: merged.condition,
    conditionDescriptor: merged.conditionDescriptor,

    

    buyingOptions: merged.buyingOptions,
    shippingOptions: merged.shippingOptions,

    marketingPrice: merged.marketingPrice,

    description: merged.fullDescription || merged.description,

    imageUrl: merged.images
  });

  // ---------------------------------------
  // Extract the JSON block ONLY (top section)
  // ---------------------------------------
  let jsonBlock = null;

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
    
    descriptionQuality
  } = scores;

  const aiScore = average([
    priceFairness,
    sellerTrust,
    conditionHonesty,
    shippingFairness,
    
    descriptionQuality
  ]);

  // Return ONLY AI-derived values
  return {
    aiScore,
    aiScores: scores,
    overview: jsonBlock?.overview || "No overview.",
    debugInfo: analysis.split("DEBUG INFO:")[1]?.trim() || "No debug info.",
    rawAnalysis: analysis
  };
}

// -----------------------------------------
// Merge AI results back into the original item
// -----------------------------------------
export async function analyzeItemsWithAI(items: any[]) {
  const analyzed = await Promise.all(
    items.map(async (item) => {
      const ai = await analyzeItemWithAI(item);

      // AI FIELDS LAST → AI ALWAYS WINS
      return {
        ...item,
        ...ai
      };
    })
  );

  return analyzed;
}
