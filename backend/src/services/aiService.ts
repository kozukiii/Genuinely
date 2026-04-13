import { analyzeListingWithImages, batchAnalyzeListingsWithImages, EBAY_BATCH_SYSTEM_PROMPT } from "../ai/ebayOverview.openai";
import { extractStructuredAnalysis } from "../utils/extractStructuredAnalysis";
import { calculatePriceFairness } from "./scoring/priceFairnessScore";

// Helper for safe average
function average(nums: Array<number | null | undefined>) {
  const valid = nums.filter((n): n is number => typeof n === "number" && !isNaN(n));
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
    shippingPrice: listing.shippingPrice ?? null,
    shippingEstimated: listing.shippingEstimated ?? false,
    // Suppress raw shippingOptions when we have an estimate — the CALCULATED type
    // would contradict the resolved price and confuse the scoring model.
    shippingOptions: listing.shippingEstimated ? undefined : (listing.shippingOptions ?? null),
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

function parseAIAnalysis(listing: any, analysis: string, context?: string | null) {
  const jsonBlock = extractStructuredAnalysis(analysis);

  if (!jsonBlock) {
    console.error("No JSON block found in AI response.");
  }

  const scores = { ...(jsonBlock?.scores || {}) };
  const { sellerTrust, conditionHonesty, shippingFairness, locationRisk, descriptionQuality } = scores;

  // Override LLM price fairness with deterministic context-based score when available
  const calculatedPriceFairness = calculatePriceFairness(
    listing.price,
    context,
    listing.condition,
    listing.title,
  );
  if (calculatedPriceFairness !== null) {
    scores.priceFairness = calculatedPriceFairness;
  }

  const aiScore = average([
    scores.priceFairness,
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
    debugInfo: buildEbayDebugInfo(listing),
    rawAnalysis: analysis,
  };
}

export async function analyzeItemWithAI(merged: any, context?: string | null) {
  const analysis = await analyzeListingWithImages(merged, context);
  return {
    ...parseAIAnalysis(merged, analysis, context),
    marketContext: context ?? undefined,
    systemPrompt: EBAY_BATCH_SYSTEM_PROMPT,
  };
}

export async function analyzeItemsWithAI(items: any[], context?: string | null, systemPrompt?: string | null) {
  if (items.length === 0) return [];

  const BATCH_SIZE = 8;
  const results: any[] = [];

  for (let start = 0; start < items.length; start += BATCH_SIZE) {
    const chunk = items.slice(start, start + BATCH_SIZE);
    const rawStrings = await batchAnalyzeListingsWithImages(chunk, context, systemPrompt);
    for (let i = 0; i < chunk.length; i++) {
      results.push({
        ...chunk[i],
        ...parseAIAnalysis(chunk[i], rawStrings[i], context),
        systemPrompt: systemPrompt ?? EBAY_BATCH_SYSTEM_PROMPT,
      });
    }
  }

  return results;
}
