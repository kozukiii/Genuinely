import { analyzeMarketplaceListingWithImages, batchAnalyzeMarketplaceListingsWithImages } from "../../ai/marketplaceOverview.openai";
import { extractStructuredAnalysis } from "../../utils/extractStructuredAnalysis";
import { calculatePriceFairness, isAcceptsOffersPrice } from "./priceFairnessScore";

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

  return JSON.stringify({
    title: listing.title ?? null,
    price: acceptsOffers ? "Accepts Offers" : listing.price,
    currency: listing.currency ?? "USD",
    location: listing.location ?? null,
    delivery_types: listing.delivery_types ?? listing.raw?.delivery_types ?? null,
    is_live: listing.is_live ?? listing.raw?.is_live ?? null,
    is_pending: listing.is_pending ?? listing.raw?.is_pending ?? null,
    is_sold: listing.is_sold ?? listing.raw?.is_sold ?? null,
    url: listing.link ?? listing.url ?? null,
    images_provided: imageUrls.length,
  }, null, 2);
}

export async function scoreMarketplaceListing(listing: any, context?: string | null) {
  const acceptsOffers = isAcceptsOffersPrice(listing.price, context);
  const analysis = await analyzeMarketplaceListingWithImages(listing, context);
  const jsonBlock = extractStructuredAnalysis(analysis);

  if (!jsonBlock) {
    console.error("No JSON block found in Marketplace AI response.");
  }

  const scores = { ...(jsonBlock?.scores || {}) };
  const { sellerTrust, conditionHonesty, shippingFairness, descriptionQuality } = scores;

  // Override LLM price fairness with deterministic context-based score when available
  const calculatedPriceFairness = acceptsOffers
    ? null
    : calculatePriceFairness(listing.price, context, listing.condition, listing.title);
  if (calculatedPriceFairness !== null) {
    scores.priceFairness = calculatedPriceFairness;
  }

  const scoreValues = acceptsOffers
    ? [sellerTrust, conditionHonesty, shippingFairness, descriptionQuality]
    : [scores.priceFairness, sellerTrust, conditionHonesty, shippingFairness, descriptionQuality];

  const aiScore = average(scoreValues);

  return {
    ...listing,
    acceptsOffers,
    aiScore,
    aiScores: scores,
    overview: jsonBlock?.overview || "No overview.",
    debugInfo: buildMarketplaceDebugInfo(listing),
    rawAnalysis: analysis,
    marketContext: context ?? undefined,
  };
}

function parseMarketplaceAnalysis(listing: any, analysis: string, context?: string | null) {
  const acceptsOffers = isAcceptsOffersPrice(listing.price, context);
  const jsonBlock = extractStructuredAnalysis(analysis);

  if (!jsonBlock) {
    console.error("No JSON block found in Marketplace AI response.");
  }

  const scores = { ...(jsonBlock?.scores || {}) };
  const { sellerTrust, conditionHonesty, shippingFairness, descriptionQuality } = scores;

  const calculatedPriceFairness = acceptsOffers
    ? null
    : calculatePriceFairness(listing.price, context, listing.condition, listing.title);
  if (calculatedPriceFairness !== null) {
    scores.priceFairness = calculatedPriceFairness;
  }

  const scoreValues = acceptsOffers
    ? [sellerTrust, conditionHonesty, shippingFairness, descriptionQuality]
    : [scores.priceFairness, sellerTrust, conditionHonesty, shippingFairness, descriptionQuality];

  const aiScore = average(scoreValues);

  return {
    ...listing,
    acceptsOffers,
    aiScore,
    aiScores: scores,
    overview: jsonBlock?.overview || "No overview.",
    debugInfo: buildMarketplaceDebugInfo(listing),
    rawAnalysis: analysis,
    marketContext: context ?? undefined,
  };
}

export async function scoreMarketplaceListings(listings: any[], context?: string | null) {
  if (listings.length === 0) return [];
  const rawStrings = await batchAnalyzeMarketplaceListingsWithImages(listings, context);
  return listings.map((listing, i) => parseMarketplaceAnalysis(listing, rawStrings[i], context));
}
