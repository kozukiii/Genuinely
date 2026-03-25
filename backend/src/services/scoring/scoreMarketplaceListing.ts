import { analyzeMarketplaceListingWithImages } from "../../ai/marketplaceOverview";

function average(nums: number[]) {
  const valid = nums.filter((n) => typeof n === "number" && !isNaN(n));
  if (valid.length === 0) return null;
  return Math.round(valid.reduce((a, b) => a + b, 0) / valid.length);
}

export async function scoreMarketplaceListing(listing: any) {
  const analysis = await analyzeMarketplaceListingWithImages(listing);

  let jsonBlock: any = null;

  try {
    const jsonMatch = analysis.match(/^\s*\{[\s\S]*?\}\s*(?=DEBUG INFO:)/);

    if (jsonMatch) {
      jsonBlock = JSON.parse(jsonMatch[0]);
    } else {
      console.error("⚠ No JSON block found in Marketplace AI response.");
      console.log("RAW:", analysis);
    }
  } catch (err) {
    console.error("Failed to parse Marketplace AI JSON:", err);
    console.log("RAW ANALYSIS:", analysis);
  }

  const scores = jsonBlock?.scores || {};

  const {
    priceFairness,
    sellerTrust,
    conditionHonesty,
    shippingFairness,
    descriptionQuality,
  } = scores;

  const aiScore = average([
    priceFairness,
    sellerTrust,
    conditionHonesty,
    shippingFairness,
    descriptionQuality,
  ]);

  return {
    ...listing,
    aiScore,
    aiScores: scores,
    overview: jsonBlock?.overview || "No overview.",
    debugInfo: analysis.split("DEBUG INFO:")[1]?.trim() || "No debug info.",
    rawAnalysis: analysis,
  };
}