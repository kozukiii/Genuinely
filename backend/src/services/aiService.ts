import { analyzeListingWithImages, batchAnalyzeListingsWithImages, EBAY_BATCH_SYSTEM_PROMPT } from "../ai/ebayOverview";
import { extractStructuredAnalysis, validateAnalysis, EMPTY_ANALYSIS } from "../utils/extractStructuredAnalysis";
import { parseEbaySellerData, calculateSellerTrust } from "./scoring/sellerTrustScore";
import { calculatePriceFairness } from "./scoring/priceFairnessScore";
import { setCachedAnalysis, setCachedAnalysisBatch } from "./analysisCache";

const EBAY_SCORE_KEYS = new Set([
  "priceFairness",
  "conditionHonesty",
  "shippingFairness",
  "descriptionQuality",
]);

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

function parseAIAnalysis(listing: any, analysis: string) {
  // Step 1: extract JSON from the raw string (defensive backup still active)
  const raw = extractStructuredAnalysis(analysis);

  if (!raw) {
    console.error("[aiService:parseAIAnalysis] No JSON block found in AI response — using EMPTY_ANALYSIS fallback");
    return {
      ...EMPTY_ANALYSIS,
      debugInfo: buildEbayDebugInfo(listing),
      rawAnalysis: analysis,
    };
  }

  // Step 2: validate and normalise — drop unexpected keys, clamp scores 0–100
  const validated = validateAnalysis(raw, EBAY_SCORE_KEYS);

  if (!validated) {
    console.error("[aiService:parseAIAnalysis] Validation failed — using EMPTY_ANALYSIS fallback");
    return {
      ...EMPTY_ANALYSIS,
      debugInfo: buildEbayDebugInfo(listing),
      rawAnalysis: analysis,
    };
  }

  const scores: Record<string, number | null | undefined> = { ...(validated.scores || {}) };

  // Step 3: always override sellerTrust with deterministic value — never accept from AI
  const { p, n } = parseEbaySellerData(listing);
  if (p !== null && n !== null) {
    scores.sellerTrust = calculateSellerTrust(p, n);
  } else {
    delete scores.sellerTrust;
  }

  // For variation listings the displayed price is a single variant — not representative
  // of the listing. Strip priceFairness entirely so it doesn't drag the overall score.
  const listingIdStr = String((listing as any).id ?? (listing as any).itemId ?? "");
  const isVariation = !!(listing as any).itemGroupId || /^v1\|\d+\|[1-9]\d*$/.test(listingIdStr);
  if (isVariation) {
    delete scores.priceFairness;
  }

  const aiScore = average([
    scores.priceFairness,
    scores.sellerTrust,
    scores.conditionHonesty,
    scores.shippingFairness,
    scores.descriptionQuality,
  ]);

  return {
    aiScore,
    aiScores: scores,
    overview: validated.overview || "No overview.",
    highlights: validated.highlights ?? [],
    debugInfo: buildEbayDebugInfo(listing),
    rawAnalysis: analysis,
  };
}

export async function analyzeItemWithAI(merged: any, context?: string | null) {
  const analysis = await analyzeListingWithImages(merged, context);
  const result = {
    ...parseAIAnalysis(merged, analysis),
    marketContext: context ?? undefined,
    systemPrompt: EBAY_BATCH_SYSTEM_PROMPT,
  };

  if (merged.id && merged.source) {
    setCachedAnalysis(merged.source, merged.id, {
      aiScore: result.aiScore,
      aiScores: result.aiScores,
      overview: result.overview,
      highlights: result.highlights,
    });
  }

  return result;
}

export async function analyzeItemsWithAI(items: any[], context?: string | null, systemPrompt?: string | null, priceLow?: number | null, priceHigh?: number | null) {
  if (items.length === 0) return [];

  // Read store once — avoids N synchronous disk reads for N items
  const resultMap = new Map<number, any>();
  const analyzeIndices = items.map((_, i) => i);

  // Score items in batches of 8, one cache write per chunk.
  const BATCH_SIZE = 8;
  for (let start = 0; start < analyzeIndices.length; start += BATCH_SIZE) {
    const batchIndices = analyzeIndices.slice(start, start + BATCH_SIZE);
    const chunk = batchIndices.map((i) => items[i]);
    const rawStrings = await batchAnalyzeListingsWithImages(chunk, context, systemPrompt);

    const toCache: Parameters<typeof setCachedAnalysisBatch>[0] = [];

    for (let j = 0; j < chunk.length; j++) {
      const item = chunk[j];
      const origIdx = batchIndices[j];
      const parsed = parseAIAnalysis(item, rawStrings[j]);

      resultMap.set(origIdx, {
        ...item,
        ...parsed,
        systemPrompt: systemPrompt ?? EBAY_BATCH_SYSTEM_PROMPT,
      });

      if (item.id && item.source) {
        toCache.push({
          source: item.source,
          id: item.id,
          result: { aiScore: parsed.aiScore, aiScores: parsed.aiScores, overview: parsed.overview, highlights: parsed.highlights },
        });
      }
    }

    setCachedAnalysisBatch(toCache);
  }

  return items.map((item, i) => {
    const result = resultMap.get(i)!;

    // Variation listings have no single representative price — skip the fairness override.
    const itemIdStr = String(item.id ?? item.itemId ?? "");
    const itemIsVariation = !!item.itemGroupId || /^v1\|\d+\|[1-9]\d*$/.test(itemIdStr);
    if (itemIsVariation) return result;

    const fairness = calculatePriceFairness(item.price, context, priceLow, priceHigh);
    if (fairness === null || !result.aiScores) return result;
    const updatedScores = { ...result.aiScores, priceFairness: fairness };
    const updatedAiScore = average([
      updatedScores.priceFairness,
      updatedScores.sellerTrust,
      updatedScores.conditionHonesty,
      updatedScores.shippingFairness,
      updatedScores.locationRisk,
      updatedScores.descriptionQuality,
    ]);
    return { ...result, aiScores: updatedScores, aiScore: updatedAiScore };
  });
}
