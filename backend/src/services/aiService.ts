import { analyzeListingWithImages, batchAnalyzeListingsWithImages } from "../ai/ebayOverview.openai";

// Helper for safe average
function average(nums: number[]) {
  const valid = nums.filter((n) => typeof n === "number" && !isNaN(n));
  if (valid.length === 0) return null;
  return Math.round(valid.reduce((a, b) => a + b, 0) / valid.length);
}


function parseAIAnalysis(analysis: string) {
  let jsonBlock: any = null;

  try {
    const jsonMatch = analysis.match(/^\s*\{[\s\S]*?\}\s*(?=DEBUG INFO:)/);
    if (jsonMatch) {
      jsonBlock = JSON.parse(jsonMatch[0]);
    } else {
      console.error("⚠ No JSON block found in AI response.");
    }
  } catch (err) {
    console.error("Failed to parse AI JSON:", err);
  }

  const scores = jsonBlock?.scores || {};
  const { priceFairness, sellerTrust, conditionHonesty, shippingFairness, locationRisk, descriptionQuality } = scores;

  const aiScore = average([priceFairness, sellerTrust, conditionHonesty, shippingFairness, locationRisk, descriptionQuality]);

  return {
    aiScore,
    aiScores: scores,
    overview: jsonBlock?.overview || "No overview.",
    debugInfo: analysis.split("DEBUG INFO:")[1]?.trim() || "No debug info.",
    rawAnalysis: analysis,
  };
}

export async function analyzeItemWithAI(merged: any) {
  const analysis = await analyzeListingWithImages(merged);
  return parseAIAnalysis(analysis);
}

export async function analyzeItemsWithAI(items: any[]) {
  if (items.length === 0) return [];

  const BATCH_SIZE = 8;
  const results: any[] = [];

  for (let start = 0; start < items.length; start += BATCH_SIZE) {
    const chunk = items.slice(start, start + BATCH_SIZE);
    const rawStrings = await batchAnalyzeListingsWithImages(chunk);
    for (let i = 0; i < chunk.length; i++) {
      results.push({ ...chunk[i], ...parseAIAnalysis(rawStrings[i]) });
    }
  }

  return results;
}
