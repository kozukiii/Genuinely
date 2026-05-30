import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigationType } from "react-router-dom";
import { Helmet } from "react-helmet-async";
import SearchBar from "../components/SearchBar";
import LinkAnalysisModal from "../components/LinkAnalysisModal";
import ListingCard from "../components/ListingCard";
import SkeletonCard from "../components/SkeletonCard";
import FiltersSidebar, { type FilterState } from "../components/FiltersSidebar";
import type { Listing } from "../types/Listing";
import LoadingBar, { type PipelineStatus } from "../components/LoadingBar";
import RefineResultsSidebar from "../components/RefineResultsSidebar";
import "./styles/HomePage.css";
import { addToSearchCache } from "../utils/searchCache";
import {
  clearAnalysisStore,
  publishAnalysisResult,
  publishAnalysisFailure,
  subscribeToAnalysis,
} from "../utils/analysisStore";
import {
  publishPipelineStatus,
  subscribeToPipelineStatus,
} from "../utils/pipelineStore";
import { hasEbayCustomizableOptions } from "../utils/ebayVariations";
import { getSavedListings } from "../utils/savedListings";
import { getRecentlyViewed } from "../utils/recentlyViewed";
import { getSearchCache } from "../utils/searchCache";

const TRENDING = [
  "PS5 console", "Air Jordan 1", "iPhone 15 Pro", "RTX 4090",
  "Pokemon cards", "MacBook Air M3", "AirPods Pro", "Nintendo Switch OLED",
  "Rolex watch", "Lego Technic", "Sony camera", "Xbox Series X",
];

function truncateTitle(s: string, n = 36) {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

const PAGE_SIZE = 12;
const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

const SEARCH_QUERY_KEY = "search:query";
const SEARCH_LISTINGS_KEY = "search:listings";
const SEARCH_TIMESTAMP_KEY = "search:ts";
const SEARCH_PAGE_KEY = "search:page";
const SEARCH_FILTERS_KEY = "search:filters";
const SEARCH_PENDING_KEY = "search:pending";

const DEFAULT_FILTERS: FilterState = {
  minPrice: "",
  maxPrice: "",
  condition: "any",
  sources: { ebay: true, marketplace: true },
  freeShippingOnly: false,
  sortBy: "ai_score",
  limit: "",
  zip: "",
  marketplaceRadius: "",
};

function parsePriceInput(raw: string): number | null {
  const n = Number(raw.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && raw.replace(/[^0-9.]/g, "") !== "" ? n : null;
}

function dedupeListings(items: Listing[]): Listing[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.source}:${item.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function fetchFromApi(
  query: string,
  targetTotal: number,
  filters: FilterState,
  offset = 0
): Promise<Listing[]> {
  const activeSources =
    (["ebay", "marketplace"] as const).filter((s) => filters.sources[s]).join(",") ||
    "ebay,marketplace";

  const minP = parsePriceInput(filters.minPrice);
  const maxP = parsePriceInput(filters.maxPrice);

  let url =
    `${API_BASE}/api/search?query=${encodeURIComponent(query)}` +
    `&limit=${targetTotal}&sources=${activeSources}&analyze=0`;

  if (minP !== null) url += `&minPrice=${minP}`;
  if (maxP !== null) url += `&maxPrice=${maxP}`;
  if (filters.sortBy && filters.sortBy !== "default" && filters.sortBy !== "ai_score") {
    url += `&sortBy=${filters.sortBy}`;
  }
  if (filters.zip?.trim()) {
    url += `&location=${encodeURIComponent(filters.zip.trim())}`;
  }
  if (filters.sources.marketplace && filters.marketplaceRadius) {
    const radiusKm = Math.round(Number(filters.marketplaceRadius) * 1.60934);
    url += `&radiusKm=${radiusKm}`;
  }
  if (offset > 0) url += `&offset=${offset}`;

  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} | ${text.slice(0, 200)}`);

  const data = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error("Response was not an array");
  return data as Listing[];
}


function stripQueryCategoryDebugInfo(listing: Listing): Listing {
  const cleanedDebugInfo = (listing.debugInfo ?? "").replace(
    /\n*\s*QUERY CATEGORY:\s*(pokemon|other)\s*$/i,
    ""
  );
  return {
    ...listing,
    ...(cleanedDebugInfo ? { debugInfo: cleanedDebugInfo } : { debugInfo: undefined }),
  };
}

// ── Analysis pipeline ────────────────────────────────────────────────────────
// Groups listings by product via context LLM, then batch-analyzes each group
// in parallel. Calls setListings incrementally as each group resolves.
const PRICE_BADGE_ORDER = ["GREAT PRICE", "GOOD PRICE", "FAIR PRICE", "HIGH PRICE", "RISKY PRICE"] as const;

type PriceBadgeLabel = typeof PRICE_BADGE_ORDER[number];

function getPriceBadge(price: number, priceLow: number, priceHigh: number): { label: PriceBadgeLabel; color: string; bg: string } {
  const mid = (priceLow + priceHigh) / 2;
  if (price < priceLow * 0.5) return { label: "RISKY PRICE", color: "#ef4444", bg: "rgba(239,68,68,0.08)" };
  if (price < priceLow) return { label: "GREAT PRICE", color: "#a855f7", bg: "rgba(168,85,247,0.08)" };
  if (price <= mid) return { label: "GOOD PRICE", color: "#22c55e", bg: "rgba(34,197,94,0.08)" };
  if (price <= priceHigh) return { label: "FAIR PRICE", color: "#facc15", bg: "rgba(250,204,21,0.08)" };
  return { label: "HIGH PRICE", color: "#ef4444", bg: "rgba(239,68,68,0.08)" };
}

function getListingPriceBadge(listing: Listing): ReturnType<typeof getPriceBadge> | null {
  if (listing.acceptsOffers) return null;
  if (hasEbayCustomizableOptions(listing)) return null;
  if (listing.price == null || listing.priceLow == null || listing.priceHigh == null) return null;
  return getPriceBadge(listing.price, listing.priceLow, listing.priceHigh);
}

function getPriceBadgeTitle(label: string): string {
  switch (label) {
    case "RISKY PRICE":
      return "Far below the expected low price, which can be a risk signal.";
    case "GREAT PRICE":
      return "Under the expected low price, but still close enough to be reasonable.";
    case "GOOD PRICE":
      return "Below the middle of the expected market range.";
    case "FAIR PRICE":
      return "Within the expected market range, closer to the high side.";
    case "HIGH PRICE":
      return "Above the expected high price for similar listings.";
    default:
      return "Based on how the listing price compares with the expected market range.";
  }
}

async function runAnalysisPipeline(
  query: string,
  items: Listing[],
  setListings: React.Dispatch<React.SetStateAction<Listing[]>>,
  signal: AbortSignal,
  onStatus?: (s: import("../components/LoadingBar").PipelineStatus) => void,
) {
  let itemsToAnalyze = items;

  try {
    const cacheRes = await fetch(`${API_BASE}/api/search/cache-lookup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ listings: items }),
      signal,
    });
    if (cacheRes.ok) {
      const cacheData = await cacheRes.json();
      const cachedRows: Array<{ index: number; listing: Listing }> = Array.isArray(cacheData.cached)
        ? cacheData.cached
        : [];

      if (cachedRows.length > 0) {
        const cachedIndexes = new Set(cachedRows.map((row) => row.index));
        const cachedListings = cachedRows.map((row) => stripQueryCategoryDebugInfo(row.listing));

        for (const listing of cachedListings) publishAnalysisResult(listing);

        setListings((prev) => {
          const updated = [...prev];
          for (const cached of cachedListings) {
            const idx = updated.findIndex((l) => l.id === cached.id && l.source === cached.source);
            if (idx !== -1) updated[idx] = { ...updated[idx], ...cached, analysisPending: false };
          }
          return updated;
        });

        try {
          const raw = sessionStorage.getItem(SEARCH_LISTINGS_KEY);
          if (raw) {
            const stored: Listing[] = JSON.parse(raw);
            if (Array.isArray(stored)) {
              for (const cached of cachedListings) {
                const idx = stored.findIndex((l) => l.id === cached.id && l.source === cached.source);
                if (idx !== -1) stored[idx] = { ...stored[idx], ...cached, analysisPending: undefined };
              }
              sessionStorage.setItem(SEARCH_LISTINGS_KEY, JSON.stringify(stored));
            }
          }
        } catch { /* ignore sessionStorage errors */ }

        itemsToAnalyze = items.filter((_, index) => !cachedIndexes.has(index));
      }
    }
  } catch (err: unknown) {
    if ((err as { name?: string })?.name === "AbortError") return;
    console.error("[analysis] cache lookup failed:", err);
  }

  if (itemsToAnalyze.length === 0) {
    onStatus?.({ phase: "done", listingsScored: items.length });
    return;
  }

  onStatus?.({ phase: "context" });

  async function retryUnscoredListings(scored: Listing[]): Promise<Listing[]> {
    const unresolved = scored.filter((l) => l.aiScore == null);
    if (unresolved.length === 0) return scored;

    const repaired = new Map<string, Listing>();
    await Promise.all(
      unresolved.map(async (listing) => {
        try {
          const res = await fetch(`${API_BASE}/api/search/analyze`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(listing),
            signal,
          });
          if (!res.ok) return;
          const retried = await res.json() as Listing;
          repaired.set(`${retried.source}:${retried.id}`, retried);
        } catch {
          // keep original unresolved listing
        }
      }),
    );

    if (repaired.size === 0) return scored;

    return scored.map((listing) => repaired.get(`${listing.source}:${listing.id}`) ?? listing);
  }

  type Group = {
    canonicalName: string;
    specificity: string;
    indices: number[];
    context: string | null;
    systemPrompt?: string;
    priceLow?: number | null;
    priceHigh?: number | null;
    priceSource?: string | null;
    priceChartingUrl?: string | null;
    tcgPlayerUrl?: string | null;
    shippingEstimate?: number | null;
  };

  let groupsDone = 0;
  let groupsTotal = 0;
  const coveredIndices = new Set<number>();
  const scoringPromises: Promise<void>[] = [];

  async function scoreGroup(group: Group): Promise<void> {
    const groupListings = group.indices.map((i) => itemsToAnalyze[i]).filter(Boolean);

    if (groupListings.length === 0) {
      groupsDone++;
      onStatus?.({ phase: "scoring", groupsDone, groupsTotal });
      return;
    }

    try {
      const listingsToScore = group.shippingEstimate != null
        ? groupListings.map((l: Listing) =>
            l.shippingPrice == null
              ? { ...l, shippingPrice: group.shippingEstimate, shippingEstimated: true }
              : l
          )
        : groupListings;

      const res = await fetch(`${API_BASE}/api/search/batch-analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          listings: listingsToScore,
          systemPrompt: group.systemPrompt,
          priceLow: group.priceLow ?? null,
          priceHigh: group.priceHigh ?? null,
          priceSource: group.priceSource ?? null,
          priceChartingUrl: group.priceChartingUrl ?? null,
          tcgPlayerUrl: group.tcgPlayerUrl ?? null,
        }),
        signal,
      });
      if (!res.ok) throw new Error(`batch-analyze HTTP ${res.status}`);
      const scored: Listing[] = await res.json();
      const stabilized = await retryUnscoredListings(scored);

      if (signal.aborted) return;

      // Attach price range and source from the context group onto every scored listing
      const priceRange: Partial<Listing> = {};
      if (group.priceLow         != null) priceRange.priceLow         = group.priceLow;
      if (group.priceHigh        != null) priceRange.priceHigh        = group.priceHigh;
      if (group.priceSource      != null) priceRange.priceSource      = group.priceSource;
      if (group.priceChartingUrl != null) priceRange.priceChartingUrl = group.priceChartingUrl;
      if (group.tcgPlayerUrl     != null) priceRange.tcgPlayerUrl     = group.tcgPlayerUrl;

      // Persist to sessionStorage directly — this runs even if SearchPage is
      // unmounted (e.g. user navigated to a listing while analysis was running).
      try {
        const raw = sessionStorage.getItem(SEARCH_LISTINGS_KEY);
        if (raw) {
          const stored: Listing[] = JSON.parse(raw);
          if (Array.isArray(stored)) {
            for (const s of stabilized) {
              const idx = stored.findIndex((l) => l.id === s.id && l.source === s.source);
              if (idx !== -1) stored[idx] = {
                ...stripQueryCategoryDebugInfo({ ...s, ...priceRange } as Listing),
                analysisPending: undefined,
              };
            }
            sessionStorage.setItem(SEARCH_LISTINGS_KEY, JSON.stringify(stored));
          }
        }
      } catch { /* ignore sessionStorage errors */ }

      // Notify any ListingPage currently viewing one of these listings
      for (const s of stabilized) {
        publishAnalysisResult({ ...s, ...priceRange } as Listing);
      }

      // Update React state — no-op if SearchPage is unmounted, but that's OK
      // since sessionStorage is already updated above.
      setListings((prev) => {
        const updated = [...prev];
        for (const s of stabilized) {
          const idx = updated.findIndex((l) => l.id === s.id && l.source === s.source);
          if (idx !== -1) updated[idx] = { ...s, ...priceRange, analysisPending: false };
        }
        return updated;
      });
      groupsDone++;
      onStatus?.({ phase: "scoring", groupsDone, groupsTotal });
    } catch (err: unknown) {
      if ((err as { name?: string })?.name === "AbortError") return;
      console.error(`[analysis] batch-analyze failed for group "${group.canonicalName}":`, err);
      groupsDone++;
      onStatus?.({ phase: "scoring", groupsDone, groupsTotal });

      // Clear pending in sessionStorage directly (same reason as above)
      try {
        const raw = sessionStorage.getItem(SEARCH_LISTINGS_KEY);
        if (raw) {
          const stored: Listing[] = JSON.parse(raw);
          if (Array.isArray(stored)) {
            for (const l of groupListings) {
              const idx = stored.findIndex((u) => u.id === l.id && u.source === l.source);
              if (idx !== -1) stored[idx] = { ...stored[idx], analysisPending: undefined };
            }
            sessionStorage.setItem(SEARCH_LISTINGS_KEY, JSON.stringify(stored));
          }
        }
      } catch { /* ignore sessionStorage errors */ }

      // Let any subscribed ListingPage know the analysis failed
      for (const l of groupListings) {
        publishAnalysisFailure(l);
      }

      // Update React state
      setListings((prev) => {
        const updated = [...prev];
        for (const l of groupListings) {
          const idx = updated.findIndex((u) => u.id === l.id && u.source === l.source);
          if (idx !== -1) updated[idx] = { ...updated[idx], analysisPending: false };
        }
        return updated;
      });
    }
  }

  // Stream context: fire scoreGroup for each group as soon as its context arrives
  try {
    const ctxRes = await fetch(`${API_BASE}/api/search/context`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, listings: itemsToAnalyze }),
      signal,
    });
    if (!ctxRes.ok) throw new Error(`context HTTP ${ctxRes.status}`);

    const reader = ctxRes.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        try {
          const event = JSON.parse(trimmed.slice(6));
          if (event.kind === "meta") {
            groupsTotal = event.total;
            onStatus?.({ phase: "scoring", groupsDone, groupsTotal });
          } else if (event.kind === "group") {
            (event.group.indices as number[]).forEach((i) => coveredIndices.add(i));
            scoringPromises.push(scoreGroup(event.group));
          }
        } catch { /* skip malformed SSE line */ }
      }
    }
  } catch (err: unknown) {
    if ((err as { name?: string })?.name === "AbortError") return;
    console.error("[analysis] context stream failed:", err);
    // Fallback: score everything as one no-context group
    groupsTotal = 1;
    onStatus?.({ phase: "scoring", groupsDone: 0, groupsTotal: 1 });
    scoringPromises.push(scoreGroup({
      canonicalName: query,
      specificity: "broad",
      indices: itemsToAnalyze.map((_, i) => i),
      context: null,
    }));
  }

  // Any indices the LLM didn't assign to a group — score with no context
  const orphanIndices = itemsToAnalyze.map((_, i) => i).filter((i) => !coveredIndices.has(i));
  if (orphanIndices.length > 0) {
    groupsTotal++;
    onStatus?.({ phase: "scoring", groupsDone, groupsTotal });
    scoringPromises.push(scoreGroup({ canonicalName: "", specificity: "broad", indices: orphanIndices, context: null }));
  }

  await Promise.all(scoringPromises);

  onStatus?.({ phase: "done", listingsScored: items.length });
}

function applyFilters(listings: Listing[], filters: FilterState): Listing[] {
  let result = listings.slice();

  if (!filters.sources.ebay) result = result.filter((l) => l.source !== "ebay");
  if (!filters.sources.marketplace) result = result.filter((l) => l.source !== "marketplace");

  const minP = parsePriceInput(filters.minPrice);
  const maxP = parsePriceInput(filters.maxPrice);
  if (minP !== null) result = result.filter((l) => l.price != null && l.price >= minP);
  if (maxP !== null) result = result.filter((l) => l.price != null && l.price <= maxP);

  if (filters.condition !== "any") {
    result = result.filter((l) => {
      const c = (l.condition ?? "").toLowerCase();
      return filters.condition === "new" ? c.startsWith("new") : !c.startsWith("new");
    });
  }

  if (filters.freeShippingOnly) {
    result = result.filter((l) => l.shippingPrice === 0 || l.shippingPrice == null);
  }

  return result;
}

export default function SearchPage() {
  const navType = useNavigationType();

  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const [listings, setListings] = useState<Listing[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(1);
  const [currentQuery, setCurrentQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initialQuery, setInitialQuery] = useState("");
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [sweeping, setSweeping] = useState(false);
  const [fetchingNew, setFetchingNew] = useState(false);
  const [resultKey, setResultKey] = useState(0);
  const [linkModalOpen, setLinkModalOpen] = useState(false);
  const [savedVersion, setSavedVersion] = useState(0);
  const [hydrated, setHydrated] = useState(false);
  const [activeHighlightFilters, setActiveHighlightFilters] = useState<string[]>([]);
  const [activePriceBadgeFilters, setActivePriceBadgeFilters] = useState<PriceBadgeLabel[]>([]);
  const [showScamListings, setShowScamListings] = useState(false);
  const [refineOpen, setRefineOpen] = useState(false);
  const [refineExiting, setRefineExiting] = useState(false);

  function closeRefine() {
    setRefineExiting(true);
    setTimeout(() => { setRefineOpen(false); setRefineExiting(false); }, 280);
  }
  const [pipelineStatus, setPipelineStatus] = useState<PipelineStatus>({ phase: "idle" });

  useEffect(() => {
    const update = () => setSavedVersion((v) => v + 1);
    window.addEventListener("saved:listings:changed", update);
    return () => window.removeEventListener("saved:listings:changed", update);
  }, []);

  // Persist filters any time they change (covers sort-only changes that don't trigger handleSearch)
  useEffect(() => {
    if (!hydrated) return;
    sessionStorage.setItem(SEARCH_FILTERS_KEY, JSON.stringify(filters));
  }, [filters, hydrated]);

  // Keep pipelineStatus in sync with the module-level store (survives unmount/remount)
  useEffect(() => subscribeToPipelineStatus(setPipelineStatus), []);

  // Merge search cache + recently viewed + saved, dedupe, shuffle
  const shelfItems = useMemo(() => {
    const cache = getSearchCache();
    const recent = getRecentlyViewed();
    const saved = getSavedListings();

    const seen = new Set<string>();
    const pool: Listing[] = [];
    for (const item of [...recent, ...saved, ...cache]) {
      const key = `${item.source}:${item.id}`;
      if (!seen.has(key) && item.images?.[0]) {
        seen.add(key);
        pool.push(item);
      }
    }

    // Fisher-Yates shuffle
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, 24);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedVersion]);

  // Keep stable refs so callbacks/effects always see the latest values
  const queryRef = useRef(currentQuery);
  queryRef.current = currentQuery;
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  // Tracks the sidebar's uncommitted draft so search uses it without requiring Apply first
  const draftFiltersRef = useRef<FilterState>(filters);
  const listingsRef = useRef(listings);
  listingsRef.current = listings;

  const pipelineStartRef = useRef<number | null>(null);

  // All active analysis controllers — all cancelled on new search/filter
  const analysisControllersRef = useRef<AbortController[]>([]);
  // Subscriptions to the module-level analysis store set up during hydration
  const hydrateSubsRef = useRef<(() => void)[]>([]);

  function abortAllAnalysis() {
    for (const ctrl of analysisControllersRef.current) ctrl.abort();
    analysisControllersRef.current = [];
    clearAnalysisStore();
  }

  function startAnalysis(query: string, items: Listing[]) {
    // Check saved listings cache — if a result was already analyzed and saved, reuse that data
    const savedMap = new Map(
      getSavedListings()
        .filter((l) => l.aiScore != null)
        .map((l) => [`${l.source}:${l.id}`, l])
    );

    const cached = items.filter((l) => savedMap.has(`${l.source}:${l.id}`));
    if (cached.length > 0) {
      setListings((prev) =>
        prev.map((l) => {
          const saved = savedMap.get(`${l.source}:${l.id}`);
          if (!saved) return l;
          return {
            ...l,
            aiScore: saved.aiScore,
            aiScores: saved.aiScores,
            overview: saved.overview,
            priceLow: saved.priceLow,
            priceHigh: saved.priceHigh,
            priceSource: saved.priceSource,
            priceChartingUrl: saved.priceChartingUrl,
            tcgPlayerUrl: saved.tcgPlayerUrl,
            debugInfo: stripQueryCategoryDebugInfo(saved).debugInfo,
            rawAnalysis: saved.rawAnalysis,
            marketContext: saved.marketContext,
            systemPrompt: saved.systemPrompt,
            analysisPending: false,
          };
        })
      );
    }

    const toAnalyze = items.filter((l) => !savedMap.has(`${l.source}:${l.id}`));
    if (toAnalyze.length === 0) return;

    const ctrl = new AbortController();
    analysisControllersRef.current.push(ctrl);
    const onStatus = (s: import("../components/LoadingBar").PipelineStatus) => {
      if (s.phase === "done") {
        const elapsedSeconds = pipelineStartRef.current != null
          ? parseFloat(((Date.now() - pipelineStartRef.current) / 1000).toFixed(1))
          : undefined;
        publishPipelineStatus({ ...s, elapsedSeconds });
      } else {
        publishPipelineStatus(s);
      }
    };
    runAnalysisPipeline(query, toAnalyze, setListings, ctrl.signal, onStatus).finally(() => {
      analysisControllersRef.current = analysisControllersRef.current.filter((c) => c !== ctrl);
    });
  }

  const filtered = useMemo(
    () => applyFilters(listings, filters),
    [listings, filters]
  );

  // Badges that appear on 2+ listings — used as quick-filter chips
  const availableHighlightBadges = useMemo(() => {
    const countMap = new Map<string, { label: string; positive: boolean; count: number }>();
    for (const listing of listings) {
      if (!Array.isArray(listing.highlights)) continue;
      const seen = new Set<string>();
      for (const h of listing.highlights) {
        const key = `${h.label}||${h.positive}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const entry = countMap.get(key);
        if (entry) entry.count++;
        else countMap.set(key, { label: h.label, positive: h.positive, count: 1 });
      }
    }
    return Array.from(countMap.values())
      .filter((b) => b.count >= 2 && b.positive)
      .sort((a, b) => b.count - a.count);
  }, [listings]);

  const availablePriceBadges = useMemo(() => {
    const countMap = new Map<PriceBadgeLabel, { label: PriceBadgeLabel; color: string; bg: string; count: number }>();
    for (const listing of filtered) {
      const badge = getListingPriceBadge(listing);
      if (!badge) continue;
      const entry = countMap.get(badge.label);
      if (entry) entry.count++;
      else countMap.set(badge.label, { ...badge, count: 1 });
    }

    return PRICE_BADGE_ORDER
      .map((label) => countMap.get(label))
      .filter((badge): badge is { label: PriceBadgeLabel; color: string; bg: string; count: number } => Boolean(badge));
  }, [filtered]);

  const displayListings = useMemo(() => {
    if (activeHighlightFilters.length === 0 && activePriceBadgeFilters.length === 0) return filtered;
    return filtered.filter((listing) => {
      if (activePriceBadgeFilters.length > 0) {
        const badge = getListingPriceBadge(listing);
        if (!badge || !activePriceBadgeFilters.includes(badge.label)) return false;
      }

      if (activeHighlightFilters.length > 0) {
        if (!Array.isArray(listing.highlights)) return false;
        return activeHighlightFilters.every((filterKey) => {
          const sep = filterKey.lastIndexOf("||");
          const label = filterKey.slice(0, sep);
          const positive = filterKey.slice(sep + 2) === "true";
          return listing.highlights!.some((h) => h.label === label && h.positive === positive);
        });
      }

      return true;
    });
  }, [filtered, activeHighlightFilters, activePriceBadgeFilters]);

  const toggleHighlightFilter = useCallback((key: string) => {
    setActiveHighlightFilters((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    );
    setPage(1);
  }, []);

  const togglePriceBadgeFilter = useCallback((label: PriceBadgeLabel) => {
    setActivePriceBadgeFilters((prev) =>
      prev.includes(label) ? prev.filter((item) => item !== label) : [...prev, label]
    );
    setPage(1);
  }, []);

  const scamCount = useMemo(
    () => displayListings.filter((l) => !l.acceptsOffers && l.aiScores?.priceFairness === 0 && l.aiScores?.sellerTrust === 0).length,
    [displayListings]
  );

  const visibleListings = useMemo(
    () => showScamListings ? displayListings : displayListings.filter((l) => l.acceptsOffers || l.aiScores?.priceFairness !== 0 || l.aiScores?.sellerTrust !== 0),
    [displayListings, showScamListings]
  );

  const totalPages = Math.max(1, Math.ceil(visibleListings.length / PAGE_SIZE));
  const canGoPrev = page > 1;
  const canGoNext = page < totalPages || hasMore;

  const pageItems = useMemo(() => {
    const slice = visibleListings.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).slice();
    const sortBy = filters.sortBy;
    if (sortBy === "price_asc") slice.sort((a, b) => (a.price ?? 0) - (b.price ?? 0));
    else if (sortBy === "price_desc") slice.sort((a, b) => (b.price ?? 0) - (a.price ?? 0));
    else if (sortBy === "ai_score") slice.sort((a, b) => (b.aiScore ?? -1) - (a.aiScore ?? -1));
    return slice;
  }, [visibleListings, page, filters.sortBy]);

  // ── Initial search (new query) ──────────────────────────────────────────
  const handleSearch = useCallback(
    async (query: string, activeFilters: FilterState = draftFiltersRef.current) => {
      const q = query.trim();
      if (!q) return;

      // Commit whatever filters were active (draft or explicit) so sidebar stays in sync
      setFilters(activeFilters);
      sessionStorage.setItem(SEARCH_FILTERS_KEY, JSON.stringify(activeFilters));

      // Cancel any in-flight analysis from a previous search
      abortAllAnalysis();
      pipelineStartRef.current = Date.now();
      publishPipelineStatus({ phase: "fetching" });
      sessionStorage.removeItem(SEARCH_PENDING_KEY);

      if (listingsRef.current.length > 0) {
        setSweeping(true);
        setTimeout(() => setSweeping(false), 300);
      }

      setFetchingNew(true);
      setLoading(true);
      setError(null);
      setCurrentQuery(q);
      setPage(1);
      setActiveHighlightFilters([]);
      setActivePriceBadgeFilters([]);
      setShowScamListings(false);

      const parsedLimit = activeFilters.limit !== "" ? Math.max(1, parseInt(activeFilters.limit, 10)) : undefined;
      const cap = parsedLimit ?? PAGE_SIZE;
      try {
        const items = await fetchFromApi(q, cap + 1, activeFilters);
        const displayItems = items.slice(0, cap);

        const withPending = displayItems.map((l: Listing) => ({ ...l, analysisPending: true }));
        setListings(withPending);
        setFetchingNew(false);
        setResultKey((k) => k + 1);
        setHasMore(items.length > cap);

        sessionStorage.setItem(SEARCH_QUERY_KEY, q);
        sessionStorage.setItem(SEARCH_LISTINGS_KEY, JSON.stringify(displayItems.map(stripQueryCategoryDebugInfo)));
        sessionStorage.setItem(SEARCH_TIMESTAMP_KEY, Date.now().toString());
        sessionStorage.setItem(SEARCH_PAGE_KEY, "1");

        startAnalysis(q, displayItems);
      } catch (err) {
        setFetchingNew(false);
        setError(`Failed to load listings: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setLoading(false);
      }
    },
    []
  );

  // ── Next page ───────────────────────────────────────────────────────────
  const handleNextPage = useCallback(async () => {
    if (!canGoNext || loading) return;

    const nextPage = page + 1;
    const needed = nextPage * PAGE_SIZE;

    if (filtered.length < needed && hasMore) {
      setLoading(true);
      try {
        // Fetch only the next batch of NEW items starting at the current end
        const offset = listingsRef.current.length;
        const newItems = await fetchFromApi(
          queryRef.current,
          PAGE_SIZE + 1,
          filtersRef.current,
          offset
        );
        const displayNew = newItems.slice(0, PAGE_SIZE);

        const pendingNew = displayNew.map((l: Listing) => ({ ...l, analysisPending: true }));
        const combined = dedupeListings([...listingsRef.current, ...pendingNew]);
        setListings(combined);
        setHasMore(newItems.length > PAGE_SIZE);

        // Clamp to last valid page so we never land on an empty page
        const newFiltered = applyFilters(combined, filtersRef.current);
        const newTotalPages = Math.max(1, Math.ceil(newFiltered.length / PAGE_SIZE));
        const targetPage = Math.min(nextPage, newTotalPages);
        setPage(targetPage);
        sessionStorage.setItem(SEARCH_PAGE_KEY, String(targetPage));
        sessionStorage.setItem(SEARCH_LISTINGS_KEY, JSON.stringify(combined.map(stripQueryCategoryDebugInfo)));

        startAnalysis(queryRef.current, displayNew);
      } catch (err) {
        setError(`Failed to load more listings: ${err instanceof Error ? err.message : String(err)}`);
        return;
      } finally {
        setLoading(false);
      }
    } else {
      setPage(nextPage);
      sessionStorage.setItem(SEARCH_PAGE_KEY, String(nextPage));

      // Trigger analysis for any items on this page not yet analyzed
      const nextPageItems = applyFilters(listingsRef.current, filtersRef.current)
        .slice((nextPage - 1) * PAGE_SIZE, nextPage * PAGE_SIZE);
      const unanalyzed = nextPageItems.filter((l) => !l.analysisPending && l.aiScore == null);
      if (unanalyzed.length > 0) {
        setListings((prev) =>
          prev.map((l) =>
            unanalyzed.some((u) => u.id === l.id && u.source === l.source)
              ? { ...l, analysisPending: true }
              : l
          )
        );
        startAnalysis(queryRef.current, unanalyzed);
      }
    }

    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [canGoNext, loading, page, filtered.length, hasMore]);

  // ── Prev page ───────────────────────────────────────────────────────────
  const handlePrevPage = useCallback(() => {
    if (!canGoPrev || loading) return;
    const prevPage = page - 1;
    setPage(prevPage);
    sessionStorage.setItem(SEARCH_PAGE_KEY, String(prevPage));
    window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
  }, [canGoPrev, loading, page]);

  // ── Re-fetch when filters are applied ───────────────────────────────────
  const handleFilterApply = useCallback(async (next: FilterState) => {
    const q = queryRef.current;
    if (!q) return;
    await handleSearch(q, next);
  }, [handleSearch]);


  // ── Hydrate from sessionStorage ─────────────────────────────────────────
  function hydrate() {
    // Clear any subscriptions from a previous hydration call
    hydrateSubsRef.current.forEach((u) => u());
    hydrateSubsRef.current = [];

    try {
      const savedQuery = sessionStorage.getItem(SEARCH_QUERY_KEY) ?? "";
      const savedRaw = sessionStorage.getItem(SEARCH_LISTINGS_KEY);
      const savedPage = sessionStorage.getItem(SEARCH_PAGE_KEY);

      if (savedQuery) { setInitialQuery(savedQuery); setCurrentQuery(savedQuery); }
      if (savedPage) setPage(Number(savedPage) || 1);
      if (savedRaw) {
        const parsed = (JSON.parse(savedRaw) as Listing[]).map(stripQueryCategoryDebugInfo);
        if (Array.isArray(parsed)) {
          setListings(parsed);
          // Re-subscribe to analysis results for items that had no score when we
          // navigated away. The module-level analysisStore survives route changes,
          // so any group that finished while SearchPage was unmounted will fire the
          // callback synchronously; groups still in-flight fire it when they land.
          hydrateSubsRef.current = parsed
            .filter((l) => l.aiScore == null)
            .map((l) =>
              subscribeToAnalysis(l, (result) => {
                if (!result) return;
                setListings((prev) =>
                  prev.map((p) =>
                    p.id === result.id && p.source === result.source
                      ? { ...result, analysisPending: false }
                      : p
                  )
                );
              })
            );
        }
      }
      const savedFilters = sessionStorage.getItem(SEARCH_FILTERS_KEY);
      if (savedFilters) {
        const parsed = JSON.parse(savedFilters) as FilterState;
        if (parsed && typeof parsed === "object") setFilters(parsed);
      }
    } catch { /* ignore sessionStorage parse errors */ }
  }

  useEffect(() => {
    hydrate();
    setHydrated(true);
  }, []);
  useEffect(() => {
    if (navType === "POP") {
      hydrate();
      setHydrated(true);
    }
  }, [navType]);

  useEffect(() => {
    if (!hydrated) return;

    const pending = sessionStorage.getItem(SEARCH_PENDING_KEY);
    const savedQuery = sessionStorage.getItem(SEARCH_QUERY_KEY)?.trim();
    if (pending !== "1" || !savedQuery) return;

    sessionStorage.removeItem(SEARCH_PENDING_KEY);
    void handleSearch(savedQuery, filtersRef.current);
  }, [hydrated, handleSearch]);


  // Persist scored listings to the search cache as they arrive
  useEffect(() => {
    const scored = listings
      .filter((l) => l.aiScore != null && !l.analysisPending)
      .map(stripQueryCategoryDebugInfo);
    if (scored.length > 0) addToSearchCache(scored);
  }, [listings]);

  const metaTitle = currentQuery
    ? `${currentQuery} — Search | Genuinely`
    : "Search Listings | Genuinely";
  const metaDescription = currentQuery
    ? `Browse AI-scored ${currentQuery} listings across eBay and Facebook Marketplace.`
    : "Search eBay and Facebook Marketplace listings. Genuinely scores every deal with AI so you know if you're getting a fair price.";

  return (
    <div className="home-page">
      <Helmet>
        <title>{metaTitle}</title>
        <meta name="description" content={metaDescription} />
      </Helmet>
      <SearchBar
        onSearch={handleSearch}
        initialQuery={initialQuery}
        onLinkAnalysis={() => setLinkModalOpen(true)}
      />
      {linkModalOpen && <LinkAnalysisModal onClose={() => setLinkModalOpen(false)} />}

      <div className="search-controls">
        <button
          className="mobile-filter-toggle"
          onClick={() => setMobileFiltersOpen((o) => !o)}
        >
          Filters {mobileFiltersOpen ? "▲" : "▼"}
        </button>

        {listings.length > 0 && (
          <span className="results-count">
            {displayListings.length}{hasMore ? "+" : ""} result{displayListings.length !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {error && <p className="mt-4 text-red-400">{error}</p>}

      <div className="search-layout">
        <FiltersSidebar
          filters={filters}
          onChange={handleFilterApply}
          onSortChange={(sortBy) => setFilters((f) => ({ ...f, sortBy }))}
          onDraftChange={(d) => { draftFiltersRef.current = d; }}
          mobileOpen={mobileFiltersOpen}
        />

        <div className="search-main">
          {!currentQuery && listings.length === 0 && !loading && !fetchingNew && (
            <div className="idle-section">
              <div className="section-head"><h2>Trending</h2></div>
              <div className="idle-ticker-viewport">
                <div className="idle-ticker-track">
                  {[...TRENDING, ...TRENDING].map((term, i) => (
                    <button key={i} className="idle-ticker-chip" onClick={() => handleSearch(term)}>
                      <span className="idle-ticker-arrow">↑</span>{term}
                    </button>
                  ))}
                </div>
              </div>

              {shelfItems.length > 0 && (
                <>
                  <div className="section-head"><h2>Past Finds</h2></div>
                  <div className="idle-shelf-scroll">
                    <div className="idle-shelf-track">
                      {[...shelfItems, ...shelfItems].map((item, i) => (
                        <button
                          key={`${item.source}:${item.id}:${i}`}
                          className="idle-shelf-card"
                          onClick={() => handleSearch(item.title)}
                          tabIndex={i < shelfItems.length ? 0 : -1}
                        >
                          <img className="idle-shelf-img" src={item.images![0]} alt="" loading="lazy" />
                          <span className="idle-shelf-name">{truncateTitle(item.title)}</span>
                          {item.price != null && (
                            <span className="idle-shelf-price">${item.price.toFixed(2)}</span>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          <LoadingBar status={pipelineStatus} />

          {refineOpen && (availableHighlightBadges.length > 0 || availablePriceBadges.length > 0) && (
            <div className={`highlight-filter-chips${refineExiting ? " highlight-filter-chips--exiting" : " highlight-filter-chips--open"}`}>
              <span className="highlight-filter-title">Refine Results</span>
              {availablePriceBadges.map((badge) => {
                const isActive = activePriceBadgeFilters.includes(badge.label);
                return (
                  <button
                    key={badge.label}
                    className={`highlight-filter-chip price-refine-chip${isActive ? " price-refine-chip--active" : ""}`}
                    style={{ color: badge.color, borderColor: `${badge.color}55`, background: isActive ? badge.bg : undefined }}
                    title={getPriceBadgeTitle(badge.label)}
                    onClick={() => togglePriceBadgeFilter(badge.label)}
                  >
                    {badge.label}
                    {isActive && <span className="highlight-filter-chip-x"> ✕</span>}
                  </button>
                );
              })}
              {availableHighlightBadges.map((badge) => {
                const key = `${badge.label}||${badge.positive}`;
                const isActive = activeHighlightFilters.includes(key);
                return (
                  <button
                    key={key}
                    className={`highlight-filter-chip highlight-filter-chip--${badge.positive ? "pos" : "neg"}${isActive ? " highlight-filter-chip--active" : ""}`}
                    onClick={() => toggleHighlightFilter(key)}
                  >
                    {badge.positive ? "+ " : "− "}{badge.label}
                    {isActive && <span className="highlight-filter-chip-x">×</span>}
                  </button>
                );
              })}
              <button
                className="sidebar-toggle refine-collapse-btn"
                onClick={closeRefine}
                title="Hide refine options"
              >
                ▶
              </button>
            </div>
          )}

          <div className="results-wrapper">
            {/* Skeleton cards — shown while fetch is in flight, after any sweep */}
            {fetchingNew && !sweeping && (
              <div className="results-container results-sweep-in">
                {Array.from({ length: PAGE_SIZE }, (_, i) => (
                  <SkeletonCard key={i} />
                ))}
              </div>
            )}

            {/* Cards — shown while sweeping out or once listings are available */}
            {(!fetchingNew || sweeping) && (
              <div
                key={resultKey}
                className={`results-container${sweeping ? " results-sweep-out" : ""}${!fetchingNew && !sweeping && resultKey > 0 ? " results-sweep-in" : ""}`}
              >
                {pageItems.map((item) => (
                  <ListingCard key={`${item.source}:${item.id}`} data={item} />
                ))}
                {!loading && listings.length > 0 && pageItems.length === 0 && (
                  <p className="empty-message">No listings match the current filters.</p>
                )}
                {!loading && !hasMore && pageItems.length > 0 && page === totalPages && (
                  <p className="end-of-results">You've reached the end of results.</p>
                )}
                {!loading && scamCount > 0 && (
                  <p className="scam-hidden-notice">
                    {showScamListings
                      ? <>Showing {scamCount} scam likely listing{scamCount !== 1 ? "s" : ""} — <button className="scam-toggle-btn" onClick={() => setShowScamListings(false)}>hide</button></>
                      : <>{scamCount} listing{scamCount !== 1 ? "s" : ""} hidden as scam likely — <button className="scam-toggle-btn" onClick={() => setShowScamListings(true)}>show</button></>
                    }
                  </p>
                )}
              </div>
            )}
          </div>

          {listings.length > 0 && (
            <div className="page-nav">
              <button
                className="page-btn"
                onClick={handlePrevPage}
                disabled={!canGoPrev || loading}
              >
                ← Prev
              </button>

              <span className="page-indicator">
                Page {page}{totalPages > 1 ? ` of ${totalPages}${hasMore ? "+" : ""}` : ""}
              </span>

              <button
                className="page-btn"
                onClick={handleNextPage}
                disabled={!canGoNext || loading}
              >
                Next →
              </button>
            </div>
          )}
        </div>

        <RefineResultsSidebar
          badges={availableHighlightBadges}
          hasPriceBadges={availablePriceBadges.length > 0}
          open={refineOpen || refineExiting}
          onToggle={() => setRefineOpen((o) => !o)}
        />
      </div>

    </div>
  );
}
