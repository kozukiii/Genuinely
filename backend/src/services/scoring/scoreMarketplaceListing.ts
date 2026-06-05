import { analyzeMarketplaceListingWithImages, batchAnalyzeMarketplaceListingsWithImages, MARKETPLACE_BATCH_SYSTEM_PROMPT } from "../../ai/marketplaceOverview";
import { batchAnalyzeMarketplaceListingsViaBatchApi } from "../../ai/marketplaceBatchApi";
import { extractStructuredAnalysis, validateAnalysis, EMPTY_ANALYSIS } from "../../utils/extractStructuredAnalysis";
import { calculatePriceFairness, isAcceptsOffersPrice } from "./priceFairnessScore";
import { setCachedAnalysis, setCachedAnalysisBatch } from "../analysisCache";

const MARKETPLACE_SCORE_KEYS = new Set([
  "priceFairness",
  "sellerTrust",
  "conditionHonesty",
  "shippingFairness",
  "descriptionQuality",
]);

function average(nums: Array<number | null | undefined>) {
  const valid = nums.filter((n): n is number => typeof n === "number" && !isNaN(n));
  if (valid.length === 0) return null;
  return Math.round(valid.reduce((a, b) => a + b, 0) / valid.length);
}

function buildMarketplaceDebugInfo(listing: any): string {
  const acceptsOffers = isAcceptsOffersPrice(listing.price);
  const imageUrls: string[] = Array.isArray(listing.imageUrls)
    ? listing.imageUrls.filter((u: any) => typeof u === "string" && u.trim())
    : Array.isArray(listing.images)
      ? listing.images.filter((u: any) => typeof u === "string" && u.trim())
      : [];

  const description = (listing.fullDescription ?? listing.description ?? "").trim() || null;

  return JSON.stringify({
    title: listing.title ?? null,
    price: acceptsOffers ? "Accepts Offers" : listing.price,
    currency: listing.currency ?? "USD",
    location: listing.location ?? null,
    description,
    delivery_types: listing.delivery_types ?? listing.raw?.delivery_types ?? null,
    is_live: listing.is_live ?? listing.raw?.is_live ?? null,
    is_pending: listing.is_pending ?? listing.raw?.is_pending ?? null,
    is_sold: listing.is_sold ?? listing.raw?.is_sold ?? null,
    url: listing.link ?? listing.url ?? null,
    images_provided: imageUrls.length,
    vision_images_attached: listing.__visionImageStats?.attached ?? null,
  }, null, 2);
}

export async function scoreMarketplaceListing(listing: any, context?: string | null) {
  const acceptsOffers = isAcceptsOffersPrice(listing.price, context);
  const hasFixedPrice = typeof listing.price === "number" && listing.price > 0 && !acceptsOffers;
  const analysis = await analyzeMarketplaceListingWithImages(listing, context);

  const raw = extractStructuredAnalysis(analysis);
  if (!raw) {
    console.error("[scoreMarketplaceListing] No JSON block found — using EMPTY_ANALYSIS fallback");
  }
  const validated = raw ? validateAnalysis(raw, MARKETPLACE_SCORE_KEYS) : null;
  if (!validated) {
    console.error("[scoreMarketplaceListing] Validation failed — using EMPTY_ANALYSIS fallback");
  }

  const scores: Record<string, number | null | undefined> = { ...(validated?.scores || {}) };
  const { sellerTrust, conditionHonesty, shippingFairness, descriptionQuality } = scores;

  // Override LLM price fairness with deterministic context-based score when available
  const calculatedPriceFairness = hasFixedPrice
    ? calculatePriceFairness(listing.price, context)
    : null;
  if (calculatedPriceFairness !== null) {
    scores.priceFairness = calculatedPriceFairness;
  } else if (!hasFixedPrice) {
    scores.priceFairness = null;
  }

  const scoreValues = !hasFixedPrice
    ? [sellerTrust, conditionHonesty, shippingFairness, descriptionQuality]
    : [scores.priceFairness, sellerTrust, conditionHonesty, shippingFairness, descriptionQuality];

  const aiScore = average(scoreValues);

  const result = {
    ...listing,
    acceptsOffers,
    aiScore,
    aiScores: scores,
    overview: validated?.overview || "No overview.",
    highlights: validated?.highlights ?? [],
    debugInfo: buildMarketplaceDebugInfo(listing),
    rawAnalysis: analysis,
    marketContext: context ?? undefined,
    systemPrompt: MARKETPLACE_BATCH_SYSTEM_PROMPT,
  };

  if (listing.id && listing.source) {
    setCachedAnalysis(listing.source, listing.id, {
      aiScore: result.aiScore,
      aiScores: result.aiScores,
      overview: result.overview,
      highlights: result.highlights,
    });
  }

  return result;
}

function parseMarketplaceAnalysis(listing: any, analysis: string, context?: string | null, priceLow?: number | null, priceHigh?: number | null) {
  const acceptsOffers = isAcceptsOffersPrice(listing.price, context);
  const hasFixedPrice = typeof listing.price === "number" && listing.price > 0 && !acceptsOffers;

  const raw = extractStructuredAnalysis(analysis);
  if (!raw) {
    console.error("[parseMarketplaceAnalysis] No JSON block found in AI response.");
  }
  const validated = raw ? validateAnalysis(raw, MARKETPLACE_SCORE_KEYS) : null;
  if (!validated) {
    console.error("[parseMarketplaceAnalysis] Validation failed — using EMPTY_ANALYSIS fallback");
  }

  const scores: Record<string, number | null | undefined> = { ...(validated?.scores || {}) };
  const { sellerTrust, conditionHonesty, shippingFairness, descriptionQuality } = scores;

  const calculatedPriceFairness = hasFixedPrice
    ? calculatePriceFairness(listing.price, context, priceLow, priceHigh)
    : null;
  if (calculatedPriceFairness !== null) {
    scores.priceFairness = calculatedPriceFairness;
  } else if (!hasFixedPrice) {
    scores.priceFairness = null;
  }

  const scoreValues = !hasFixedPrice
    ? [sellerTrust, conditionHonesty, shippingFairness, descriptionQuality]
    : [scores.priceFairness, sellerTrust, conditionHonesty, shippingFairness, descriptionQuality];

  const aiScore = average(scoreValues);

  return {
    ...listing,
    acceptsOffers,
    aiScore,
    aiScores: scores,
    overview: validated?.overview || "No overview.",
    highlights: validated?.highlights ?? [],
    debugInfo: buildMarketplaceDebugInfo(listing),
    rawAnalysis: analysis,
    marketContext: context ?? undefined,
    systemPrompt: MARKETPLACE_BATCH_SYSTEM_PROMPT,
  };
}

export async function scoreMarketplaceListings(listings: any[], context?: string | null, systemPrompt?: string | null, priceLow?: number | null, priceHigh?: number | null) {
  if (listings.length === 0) return [];

  const resultMap = new Map<number, any>();
  // Live marketplace scoring runs through Groq's async Batch API (separate TPM
  // pool, ~50% cost); the synchronous packed call stays only as a fallback on
  // batch timeout/error so users are never stranded.
  let rawStrings: string[];
  try {
    rawStrings = await batchAnalyzeMarketplaceListingsViaBatchApi(listings, context, systemPrompt);
  } catch (err) {
    console.error("[scoreMarketplaceListings] Groq Batch API path failed — falling back to synchronous:", err);
    rawStrings = await batchAnalyzeMarketplaceListingsWithImages(listings, context, systemPrompt, { stitch: true });
  }
  const toCache: Parameters<typeof setCachedAnalysisBatch>[0] = [];

  for (let i = 0; i < listings.length; i++) {
    const listing = listings[i];
    const parsed = parseMarketplaceAnalysis(listing, rawStrings[i], context, priceLow, priceHigh);
    const result = {
      ...parsed,
      systemPrompt: systemPrompt ?? MARKETPLACE_BATCH_SYSTEM_PROMPT,
    };

    resultMap.set(i, result);
    if (listing.id && listing.source) {
      toCache.push({
        source: listing.source,
        id: listing.id,
        result: {
          aiScore: result.aiScore,
          aiScores: result.aiScores,
          overview: result.overview,
          highlights: result.highlights,
        },
      });
    }
  }

  setCachedAnalysisBatch(toCache);

  return listings.map((_, i) => resultMap.get(i) ?? listings[i]);
}
