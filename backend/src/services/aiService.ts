import { analyzeListingWithImages, batchAnalyzeListingsWithImages } from "../ai/ebayOverview.openai";

// Helper for safe average
function average(nums: number[]) {
  const valid = nums.filter((n) => typeof n === "number" && !isNaN(n));
  if (valid.length === 0) return null;
  return Math.round(valid.reduce((a, b) => a + b, 0) / valid.length);
}


function buildEbayDebugInfo(listing: any): string {
  const imageUrls: string[] = Array.isArray(listing.imageUrls)
    ? listing.imageUrls.filter((u: any) => typeof u === "string" && u.trim())
    : Array.isArray(listing.images)
      ? listing.images.filter((u: any) => typeof u === "string" && u.trim())
      : [];

  const loc = listing.itemLocation ?? listing.location;
  let locationStr: string;
  if (loc && typeof loc === "object") {
    locationStr = [loc.city, loc.stateOrProvince, loc.postalCode, loc.country].filter(Boolean).join(", ");
  } else {
    locationStr = loc ?? null;
  }

  return JSON.stringify({
    title: listing.title ?? null,
    price: listing.price ?? null,
    currency: listing.currency ?? "USD",
    seller: listing.seller ?? null,
    feedback: listing.feedback ?? null,
    score: listing.score ?? null,
    condition: listing.condition ?? null,
    conditionDescriptor: listing.conditionDescriptor ?? null,
    itemLocation: locationStr,
    buyingOptions: listing.buyingOptions ?? null,
    shippingOptions: listing.shippingOptions ?? null,
    originalPrice: listing.marketingPrice?.originalPrice ?? null,
    discount: listing.marketingPrice?.discountPercentage ?? listing.marketingPrice?.discountPercent ?? null,
    shortDescription: listing.shortDescription ?? null,
    description_sent_to_llm: (() => {
      const raw = listing.description || listing.fullDescription || "";
      return raw.replace(/<[^>]*>/g, " ").replace(/\s{2,}/g, " ").trim() || null;
    })(),
    url: listing.link ?? listing.url ?? null,
    images_provided: imageUrls.length,
  }, null, 2);
}

function parseAIAnalysis(listing: any, analysis: string) {
  let jsonBlock: any = null;

  try {
    const jsonMatch = analysis.match(/^\s*\{[\s\S]*?\}\s*(?=DEBUG INFO:)/);
    if (jsonMatch) {
      jsonBlock = JSON.parse(jsonMatch[0]);
    } else {
      try { jsonBlock = JSON.parse(analysis); } catch { /* ignore */ }
      if (!jsonBlock) console.error("⚠ No JSON block found in AI response.");
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
    debugInfo: buildEbayDebugInfo(listing),
    rawAnalysis: analysis,
  };
}

export async function analyzeItemWithAI(merged: any) {
  const analysis = await analyzeListingWithImages(merged);
  return parseAIAnalysis(merged, analysis);
}

export async function analyzeItemsWithAI(items: any[]) {
  if (items.length === 0) return [];

  const BATCH_SIZE = 8;
  const results: any[] = [];

  for (let start = 0; start < items.length; start += BATCH_SIZE) {
    const chunk = items.slice(start, start + BATCH_SIZE);
    const rawStrings = await batchAnalyzeListingsWithImages(chunk);
    for (let i = 0; i < chunk.length; i++) {
      results.push({ ...chunk[i], ...parseAIAnalysis(chunk[i], rawStrings[i]) });
    }
  }

  return results;
}
