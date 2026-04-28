import { analyzeListingWithImages, batchAnalyzeListingsWithImages, EBAY_BATCH_SYSTEM_PROMPT } from "../ai/ebayOverview";
import { extractStructuredAnalysis } from "../utils/extractStructuredAnalysis";
import { parseEbaySellerData, calculateSellerTrust } from "./scoring/sellerTrustScore";
import { calculatePriceFairness } from "./scoring/priceFairnessScore";
import { getCachedAnalysis, setCachedAnalysis, setCachedAnalysisBatch, readCacheStore, getCachedAnalysisFromStore } from "./analysisCache";

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
  const { conditionHonesty, shippingFairness, locationRisk, descriptionQuality } = scores;

  // Calculate sellerTrust deterministically — never use the LLM's value
  const { p, n } = parseEbaySellerData(listing);
  if (p !== null && n !== null) {
    scores.sellerTrust = calculateSellerTrust(p, n);
  } else {
    delete scores.sellerTrust;
  }

  const aiScore = average([
    scores.priceFairness,
    scores.sellerTrust,
    conditionHonesty,
    shippingFairness,
    locationRisk,
    descriptionQuality,
  ]);

  return {
    aiScore,
    aiScores: scores,
    overview: jsonBlock?.overview || "No overview.",
    highlights: jsonBlock?.highlights,
    debugInfo: buildEbayDebugInfo(listing),
    rawAnalysis: analysis,
  };
}

export async function analyzeItemWithAI(merged: any, context?: string | null) {
  const cached = merged.id && merged.source
    ? getCachedAnalysis(merged.source, merged.id)
    : null;

  if (cached) {
    return {
      aiScore: cached.aiScore,
      aiScores: cached.aiScores,
      overview: cached.overview,
      highlights: cached.highlights,
      debugInfo: buildEbayDebugInfo(merged),
      rawAnalysis: "",
      marketContext: context ?? undefined,
      systemPrompt: EBAY_BATCH_SYSTEM_PROMPT,
    };
  }

  const analysis = await analyzeListingWithImages(merged, context);
  const result = {
    ...parseAIAnalysis(merged, analysis, context),
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
  const store = readCacheStore();
  const resultMap = new Map<number, any>();
  const uncachedIndices: number[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const cached = item.id && item.source
      ? getCachedAnalysisFromStore(store, item.source, item.id)
      : null;

    if (cached) {
      console.log(`[analysisCache] HIT  ${item.source}-${item.id}`);
      resultMap.set(i, {
        ...item,
        aiScore: cached.aiScore,
        aiScores: cached.aiScores,
        overview: cached.overview,
        highlights: cached.highlights,
        debugInfo: buildEbayDebugInfo(item),
        rawAnalysis: "",
        systemPrompt: systemPrompt ?? EBAY_BATCH_SYSTEM_PROMPT,
      });
    } else {
      uncachedIndices.push(i);
    }
  }

  console.log(`[analysisCache] ${items.length - uncachedIndices.length}/${items.length} hits, ${uncachedIndices.length} going to Groq`);

  // Score uncached items in batches of 8, one read+write per chunk
  const BATCH_SIZE = 8;
  for (let start = 0; start < uncachedIndices.length; start += BATCH_SIZE) {
    const batchIndices = uncachedIndices.slice(start, start + BATCH_SIZE);
    const chunk = batchIndices.map((i) => items[i]);
    const rawStrings = await batchAnalyzeListingsWithImages(chunk, context, systemPrompt);

    const toCache: Parameters<typeof setCachedAnalysisBatch>[0] = [];

    for (let j = 0; j < chunk.length; j++) {
      const item = chunk[j];
      const origIdx = batchIndices[j];
      const parsed = parseAIAnalysis(item, rawStrings[j], context);

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
