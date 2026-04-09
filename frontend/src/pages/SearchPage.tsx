import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigationType } from "react-router-dom";
import SearchBar from "../components/SearchBar";
import LinkAnalysisModal from "../components/LinkAnalysisModal";
import ListingCard from "../components/ListingCard";
import SkeletonCard from "../components/SkeletonCard";
import FiltersSidebar, { type FilterState } from "../components/FiltersSidebar";
import type { Listing } from "../types/Listing";
import "./styles/HomePage.css";
import { setEbayNotice } from "../utils/ebayNotice";
import { addToSearchCache } from "../utils/searchCache";

const PAGE_SIZE = 12;
const PRELOAD_SIZE = PAGE_SIZE; // fetch first page, then background-prefetch next
const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

const SEARCH_QUERY_KEY = "search:query";
const SEARCH_LISTINGS_KEY = "search:listings";
const SEARCH_TIMESTAMP_KEY = "search:ts";
const SEARCH_PAGE_KEY = "search:page";

const DEFAULT_FILTERS: FilterState = {
  minPrice: "",
  maxPrice: "",
  condition: "any",
  sources: { ebay: true, marketplace: true },
  freeShippingOnly: false,
  sortBy: "default",
  limit: "",
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
): Promise<{ items: Listing[]; ebayUnavailable: boolean }> {
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
  if (offset > 0) url += `&offset=${offset}`;

  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} | ${text.slice(0, 200)}`);

  const data = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error("Response was not an array");
  return {
    items: data as Listing[],
    ebayUnavailable: res.headers.get("X-Ebay-Search-Status") === "unavailable",
  };
}

// ── Analysis pipeline ────────────────────────────────────────────────────────
// Groups listings by product via context LLM, then batch-analyzes each group
// in parallel. Calls setListings incrementally as each group resolves.
async function runAnalysisPipeline(
  query: string,
  items: Listing[],
  setListings: React.Dispatch<React.SetStateAction<Listing[]>>,
  signal: AbortSignal,
) {
  // 1. Get product groups + Tavily context per group
  let groups: Array<{
    canonicalName: string;
    specificity: string;
    indices: number[];
    context: string | null;
    systemPrompt?: string;
    priceLow?: number | null;
    priceHigh?: number | null;
  }>;

  try {
    const ctxRes = await fetch(`${API_BASE}/api/search/context`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, listings: items }),
      signal,
    });
    if (!ctxRes.ok) throw new Error(`context HTTP ${ctxRes.status}`);
    const ctxData = await ctxRes.json();
    groups = ctxData.groups ?? [];
  } catch (err: any) {
    if (err?.name === "AbortError") return;
    console.error("[analysis] context call failed:", err);
    // Fallback: one group with no context
    groups = [{ canonicalName: query, specificity: "broad", indices: items.map((_, i) => i), context: null }];
  }

  // 2. Analyze each group in parallel — update state as each one resolves
  await Promise.all(
    groups.map(async (group) => {
      const groupListings = group.indices
        .map((i) => items[i])
        .filter(Boolean);

      if (groupListings.length === 0) return;

      try {
        const res = await fetch(`${API_BASE}/api/search/batch-analyze`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ listings: groupListings, systemPrompt: group.systemPrompt }),
          signal,
        });
        if (!res.ok) throw new Error(`batch-analyze HTTP ${res.status}`);
        const scored: Listing[] = await res.json();

        if (signal.aborted) return;

        // Attach price range from the context group onto every scored listing
        const priceRange: Partial<Listing> = {};
        if (group.priceLow  != null) priceRange.priceLow  = group.priceLow;
        if (group.priceHigh != null) priceRange.priceHigh = group.priceHigh;

        // Merge scored listings back by id+source, then persist to sessionStorage
        // so back-navigation restores scores without re-running the pipeline.
        setListings((prev) => {
          const updated = [...prev];
          for (const s of scored) {
            const idx = updated.findIndex(
              (l) => l.id === s.id && l.source === s.source,
            );
            if (idx !== -1) updated[idx] = { ...s, ...priceRange, analysisPending: false };
          }
          try {
            const toSave = updated.map((l) => ({ ...l, analysisPending: undefined }));
            sessionStorage.setItem(SEARCH_LISTINGS_KEY, JSON.stringify(toSave));
          } catch {}
          return updated;
        });
      } catch (err: any) {
        if (err?.name === "AbortError") return;
        console.error(`[analysis] batch-analyze failed for group "${group.canonicalName}":`, err);

        // Clear pending state for this group on failure and persist
        setListings((prev) => {
          const updated = [...prev];
          for (const l of groupListings) {
            const idx = updated.findIndex((u) => u.id === l.id && u.source === l.source);
            if (idx !== -1) updated[idx] = { ...updated[idx], analysisPending: false };
          }
          try {
            const toSave = updated.map((l) => ({ ...l, analysisPending: undefined }));
            sessionStorage.setItem(SEARCH_LISTINGS_KEY, JSON.stringify(toSave));
          } catch {}
          return updated;
        });
      }
    }),
  );
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

  if (filters.sortBy === "price_asc") result.sort((a, b) => (a.price ?? 0) - (b.price ?? 0));
  else if (filters.sortBy === "price_desc") result.sort((a, b) => (b.price ?? 0) - (a.price ?? 0));
  else if (filters.sortBy === "ai_score") {
    result.sort((a, b) => (b.aiScore ?? -1) - (a.aiScore ?? -1));
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

  // Keep stable refs so callbacks/effects always see the latest values
  const queryRef = useRef(currentQuery);
  queryRef.current = currentQuery;
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const prefetchingRef = useRef(false);
  const listingsRef = useRef(listings);
  listingsRef.current = listings;

  // All active analysis controllers — all cancelled on new search/filter
  const analysisControllersRef = useRef<AbortController[]>([]);

  function abortAllAnalysis() {
    for (const ctrl of analysisControllersRef.current) ctrl.abort();
    analysisControllersRef.current = [];
  }

  function startAnalysis(query: string, items: Listing[]) {
    const ctrl = new AbortController();
    analysisControllersRef.current.push(ctrl);
    runAnalysisPipeline(query, items, setListings, ctrl.signal).finally(() => {
      analysisControllersRef.current = analysisControllersRef.current.filter((c) => c !== ctrl);
    });
  }

  const filtered = useMemo(
    () => applyFilters(listings, filters),
    [listings, filters]
  );

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const canGoPrev = page > 1;
  const canGoNext = page < totalPages || hasMore;

  const pageItems = useMemo(
    () => filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [filtered, page]
  );

  // ── Initial search (new query) ──────────────────────────────────────────
  const handleSearch = useCallback(
    async (query: string) => {
      const q = query.trim();
      if (!q) return;

      // Cancel any in-flight analysis from a previous search
      abortAllAnalysis();

      if (listingsRef.current.length > 0) {
        setSweeping(true);
        setTimeout(() => setSweeping(false), 300);
      }

      setFetchingNew(true);
      setLoading(true);
      setError(null);
      setCurrentQuery(q);
      setPage(1);

      const parsedLimit = filtersRef.current.limit !== "" ? Math.max(1, parseInt(filtersRef.current.limit, 10)) : undefined;
      const fetchSize = parsedLimit ?? PRELOAD_SIZE;
      try {
        const { items, ebayUnavailable } = await fetchFromApi(q, fetchSize, filters);
        setEbayNotice(filters.sources.ebay && ebayUnavailable);

        // Mark all listings as pending immediately so rings show spinners
        const pending = items.map((l) => ({ ...l, analysisPending: true }));
        setListings(pending);
        setFetchingNew(false);
        setResultKey((k) => k + 1);
        setHasMore(items.length >= fetchSize);

        sessionStorage.setItem(SEARCH_QUERY_KEY, q);
        sessionStorage.setItem(SEARCH_LISTINGS_KEY, JSON.stringify(items));
        sessionStorage.setItem(SEARCH_TIMESTAMP_KEY, Date.now().toString());
        sessionStorage.setItem(SEARCH_PAGE_KEY, "1");

        // Kick off the background analysis pipeline
        startAnalysis(q, items);
      } catch (err) {
        setFetchingNew(false);
        setEbayNotice(filters.sources.ebay);
        setError(`Failed to load listings: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setLoading(false);
      }
    },
    [filters.sources]
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
        const { items: newItems, ebayUnavailable } = await fetchFromApi(
          queryRef.current,
          PRELOAD_SIZE,
          filtersRef.current,
          offset
        );
        setEbayNotice(filtersRef.current.sources.ebay && ebayUnavailable);

        const pendingNew = newItems.map((l) => ({ ...l, analysisPending: true }));
        const combined = dedupeListings([...listingsRef.current, ...pendingNew]);
        setListings(combined);
        setHasMore(newItems.length >= PAGE_SIZE);

        // Clamp to last valid page so we never land on an empty page
        const newFiltered = applyFilters(combined, filtersRef.current);
        const newTotalPages = Math.max(1, Math.ceil(newFiltered.length / PAGE_SIZE));
        const targetPage = Math.min(nextPage, newTotalPages);
        setPage(targetPage);
        sessionStorage.setItem(SEARCH_PAGE_KEY, String(targetPage));
        sessionStorage.setItem(SEARCH_LISTINGS_KEY, JSON.stringify(combined));

        startAnalysis(queryRef.current, newItems);
      } catch (err) {
        setEbayNotice(filtersRef.current.sources.ebay);
        setError(`Failed to load more listings: ${err instanceof Error ? err.message : String(err)}`);
        return;
      } finally {
        setLoading(false);
      }
    } else {
      setPage(nextPage);
      sessionStorage.setItem(SEARCH_PAGE_KEY, String(nextPage));
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
    setFilters(next);
    const q = queryRef.current;
    if (!q) return;

    abortAllAnalysis();
    setFetchingNew(true);
    setLoading(true);
    setError(null);
    setPage(1);

    try {
      const parsedLimit = next.limit !== "" ? Math.max(1, parseInt(next.limit, 10)) : undefined;
      const fetchSize = parsedLimit ?? PRELOAD_SIZE;
      const { items, ebayUnavailable } = await fetchFromApi(q, fetchSize, next);
      setEbayNotice(next.sources.ebay && ebayUnavailable);

      const pending = items.map((l) => ({ ...l, analysisPending: true }));
      setListings(pending);
      setFetchingNew(false);
      setResultKey((k) => k + 1);
      setHasMore(items.length >= fetchSize);
      sessionStorage.setItem(SEARCH_LISTINGS_KEY, JSON.stringify(items));
      sessionStorage.setItem(SEARCH_PAGE_KEY, "1");

      startAnalysis(q, items);
    } catch (err) {
      setFetchingNew(false);
      setEbayNotice(next.sources.ebay);
      setError(`Failed to load listings: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }, []);

// ── Background prefetch: silently load next page while user reads current ──
  useEffect(() => {
    const nextNeeded = (page + 1) * PAGE_SIZE;
    if (!currentQuery || !hasMore || listings.length >= nextNeeded || loading || prefetchingRef.current) return;

    prefetchingRef.current = true;
    const prefetchOffset = listings.length;
    fetchFromApi(currentQuery, PAGE_SIZE, filtersRef.current, prefetchOffset)
      .then(({ items: newItems, ebayUnavailable }) => {
        setEbayNotice(filtersRef.current.sources.ebay && ebayUnavailable);
        const pendingNew = newItems.map((l) => ({ ...l, analysisPending: true }));
        const combined = dedupeListings([...listingsRef.current, ...pendingNew]);
        setListings(combined);
        setHasMore(newItems.length >= PAGE_SIZE);
        sessionStorage.setItem(SEARCH_LISTINGS_KEY, JSON.stringify(combined));
        startAnalysis(currentQuery, newItems);
      })
      .catch(() => {})
      .finally(() => { prefetchingRef.current = false; });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, hasMore, listings.length, loading]);

  // ── Hydrate from sessionStorage ─────────────────────────────────────────
  function hydrate() {
    try {
      const savedQuery = sessionStorage.getItem(SEARCH_QUERY_KEY) ?? "";
      const savedRaw = sessionStorage.getItem(SEARCH_LISTINGS_KEY);
      const savedPage = sessionStorage.getItem(SEARCH_PAGE_KEY);

      if (savedQuery) { setInitialQuery(savedQuery); setCurrentQuery(savedQuery); }
      if (savedPage) setPage(Number(savedPage) || 1);
      if (savedRaw) {
        const parsed = JSON.parse(savedRaw) as Listing[];
        if (Array.isArray(parsed)) setListings(parsed);
      }
    } catch {}
  }

  useEffect(() => { hydrate(); }, []);
  useEffect(() => { if (navType === "POP") hydrate(); }, [navType]);


  // Persist scored listings to the search cache as they arrive
  useEffect(() => {
    const scored = listings.filter((l) => l.aiScore != null && !l.analysisPending);
    if (scored.length > 0) addToSearchCache(scored);
  }, [listings]);

  return (
    <div className="home-page">
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
            {filtered.length}{hasMore ? "+" : ""} result{filtered.length !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {error && <p className="mt-4 text-red-400">{error}</p>}

      <div className="search-layout">
        <FiltersSidebar
          filters={filters}
          onChange={handleFilterApply}
          onSortChange={(sortBy) => setFilters((f) => ({ ...f, sortBy }))}
          mobileOpen={mobileFiltersOpen}
        />

        <div className="search-main">
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
      </div>

    </div>
  );
}
