import {
  getCachedAnalysis,
  getCachedAnalysisFromStore,
  type AnalysisCacheEntry,
  type AnalysisCacheStore,
} from "./analysisCache";

export function cachedAnalysisPatch(
  source: string | undefined,
  id: string | undefined,
): (AnalysisCacheEntry & { rawAnalysis: string }) | null {
  if (!source || !id) return null;
  const cached = getCachedAnalysis(source, id);
  if (!cached) return null;
  return { ...cached, rawAnalysis: "" };
}

export function applyCachedAnalysis<T extends Record<string, any>>(listing: T): T | null {
  const cached = cachedAnalysisPatch(listing.source, listing.id);
  return cached ? applyPatch(listing, cached) : null;
}

export function applyCachedAnalysisFromStore<T extends Record<string, any>>(
  store: AnalysisCacheStore,
  listing: T,
): T | null {
  if (!listing.source || !listing.id) return null;
  const cached = getCachedAnalysisFromStore(store, listing.source, listing.id);
  if (!cached) return null;
  return applyPatch(listing, { ...cached, rawAnalysis: "" });
}

function applyPatch<T extends Record<string, any>>(
  listing: T,
  cached: AnalysisCacheEntry & { rawAnalysis: string },
): T {
  return {
    ...listing,
    aiScore: cached.aiScore,
    aiScores: cached.aiScores,
    overview: cached.overview,
    highlights: cached.highlights,
    rawAnalysis: cached.rawAnalysis,
    analysisPending: false,
    // Restore price range/source so the graph + badges render on cache hits.
    ...(cached.priceLow != null ? { priceLow: cached.priceLow } : {}),
    ...(cached.priceHigh != null ? { priceHigh: cached.priceHigh } : {}),
    ...(cached.priceSource ? { priceSource: cached.priceSource } : {}),
    ...(cached.priceChartingUrl ? { priceChartingUrl: cached.priceChartingUrl } : {}),
    ...(cached.tcgPlayerUrl ? { tcgPlayerUrl: cached.tcgPlayerUrl } : {}),
  };
}
