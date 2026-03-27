import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigationType } from "react-router-dom";
import SearchBar from "../components/SearchBar";
import ListingCard from "../components/ListingCard";
import FiltersSidebar, { type FilterState } from "../components/FiltersSidebar";
import type { Listing } from "../types/Listing";
import "./styles/HomePage.css";
import { setEbayNotice } from "../utils/ebayNotice";

const PAGE_SIZE = 12;
const PRELOAD_SIZE = PAGE_SIZE * 2; // always fetch 2 pages up-front
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
};

async function fetchFromApi(
  query: string,
  targetTotal: number,
  sources: { ebay: boolean; marketplace: boolean },
  analyze: boolean
): Promise<{ items: Listing[]; ebayUnavailable: boolean }> {
  const activeSources =
    (["ebay", "marketplace"] as const).filter((s) => sources[s]).join(",") ||
    "ebay,marketplace";

  const url =
    `${API_BASE}/api/search?query=${encodeURIComponent(query)}` +
    `&limit=${targetTotal}&sources=${activeSources}` +
    `&analyze=${analyze ? "1" : "0"}`;

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

function applyFilters(listings: Listing[], filters: FilterState): Listing[] {
  let result = listings.slice();

  const minP = filters.minPrice !== "" ? Number(filters.minPrice) : null;
  const maxP = filters.maxPrice !== "" ? Number(filters.maxPrice) : null;
  if (minP !== null && Number.isFinite(minP)) result = result.filter((l) => l.price >= minP);
  if (maxP !== null && Number.isFinite(maxP)) result = result.filter((l) => l.price <= maxP);

  if (filters.condition !== "any") {
    result = result.filter((l) => {
      const c = (l.condition ?? "").toLowerCase();
      return filters.condition === "new" ? c.startsWith("new") : !c.startsWith("new");
    });
  }

  if (filters.freeShippingOnly) {
    result = result.filter((l) => l.shippingPrice === 0 || l.shippingPrice == null);
  }

  if (filters.sortBy === "price_asc") result.sort((a, b) => a.price - b.price);
  else if (filters.sortBy === "price_desc") result.sort((a, b) => b.price - a.price);
  else if (filters.sortBy === "ai_score") {
    result.sort((a, b) => (b.aiScore ?? -1) - (a.aiScore ?? -1));
  }

  return result;
}

export default function SearchPage() {
  const navType = useNavigationType();

  const [demoMode, setDemoMode] = useState(true);
  const [listings, setListings] = useState<Listing[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(1);
  const [currentQuery, setCurrentQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initialQuery, setInitialQuery] = useState("");
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [sweeping, setSweeping] = useState(false);
  const [resultKey, setResultKey] = useState(0);

  // Keep a stable ref so effects can read the latest query/sources without re-running
  const queryRef = useRef(currentQuery);
  queryRef.current = currentQuery;
  const sourcesRef = useRef(filters.sources);
  sourcesRef.current = filters.sources;
  const prefetchingRef = useRef(false);
const listingsRef = useRef(listings);
  listingsRef.current = listings;

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
    async (query: string, limitOverride?: number) => {
      const q = query.trim();
      if (!q) return;

      if (listingsRef.current.length > 0) {
        setSweeping(true);
        setTimeout(() => setSweeping(false), 300);
      }

      setLoading(true);
      setError(null);
      setCurrentQuery(q);
      setPage(1);

      const fetchSize = limitOverride ?? PRELOAD_SIZE;
      try {
        const { items, ebayUnavailable } = await fetchFromApi(q, fetchSize, filters.sources, !demoMode);
        setEbayNotice(filters.sources.ebay && ebayUnavailable);
        setListings(items);
        setResultKey((k) => k + 1);
        setHasMore(items.length >= fetchSize);

        sessionStorage.setItem(SEARCH_QUERY_KEY, q);
        sessionStorage.setItem(SEARCH_LISTINGS_KEY, JSON.stringify(items));
        sessionStorage.setItem(SEARCH_TIMESTAMP_KEY, Date.now().toString());
        sessionStorage.setItem(SEARCH_PAGE_KEY, "1");
      } catch (err) {
        setEbayNotice(filters.sources.ebay);
        setError(`Failed to load listings: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setLoading(false);
      }
    },
    [demoMode, filters.sources]
  );

  // ── Next page ───────────────────────────────────────────────────────────
  const handleNextPage = useCallback(async () => {
    if (!canGoNext || loading) return;

    const nextPage = page + 1;
    const needed = nextPage * PAGE_SIZE;

    if (filtered.length < needed && hasMore) {
      setLoading(true);
      try {
        const { items, ebayUnavailable } = await fetchFromApi(
          queryRef.current,
          needed + PAGE_SIZE, // fetch a page ahead so next-next doesn't stall
          sourcesRef.current,
          !demoMode
        );
        setEbayNotice(sourcesRef.current.ebay && ebayUnavailable);
        setListings(items);
        setHasMore(items.length >= needed + PAGE_SIZE);

        sessionStorage.setItem(SEARCH_LISTINGS_KEY, JSON.stringify(items));
      } catch (err) {
        setEbayNotice(sourcesRef.current.ebay);
        setError(`Failed to load more listings: ${err instanceof Error ? err.message : String(err)}`);
        return;
      } finally {
        setLoading(false);
      }
    }

    setPage(nextPage);
    sessionStorage.setItem(SEARCH_PAGE_KEY, String(nextPage));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [canGoNext, loading, page, filtered.length, hasMore, demoMode]);

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

    setLoading(true);
    setError(null);
    setPage(1);

    try {
      const { items, ebayUnavailable } = await fetchFromApi(q, PRELOAD_SIZE, next.sources, !demoMode);
      setEbayNotice(next.sources.ebay && ebayUnavailable);
      setListings(items);
      setResultKey((k) => k + 1);
      setHasMore(items.length >= PRELOAD_SIZE);
      sessionStorage.setItem(SEARCH_LISTINGS_KEY, JSON.stringify(items));
      sessionStorage.setItem(SEARCH_PAGE_KEY, "1");
    } catch (err) {
      setEbayNotice(next.sources.ebay);
      setError(`Failed to load listings: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }, [demoMode]);

// ── Background prefetch: silently load next page while user reads current ──
  useEffect(() => {
    const nextNeeded = (page + 1) * PAGE_SIZE;
    if (!currentQuery || !hasMore || listings.length >= nextNeeded || loading || prefetchingRef.current) return;

    prefetchingRef.current = true;
    fetchFromApi(currentQuery, nextNeeded, filters.sources, !demoMode)
      .then(({ items, ebayUnavailable }) => {
        setEbayNotice(filters.sources.ebay && ebayUnavailable);
        setListings(items);
        setHasMore(items.length >= nextNeeded);
        sessionStorage.setItem(SEARCH_LISTINGS_KEY, JSON.stringify(items));
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

  return (
    <div className="home-page">
      <SearchBar onSearch={handleSearch} initialQuery={initialQuery} />

      <div className="search-controls">
        <label className="demo-toggle">
          <input
            type="checkbox"
            checked={demoMode}
            onChange={(e) => setDemoMode(e.target.checked)}
          />
          Demo mode
        </label>

        {listings.length > 0 && (
          <span className="results-count">
            {filtered.length}+ result{filtered.length !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {error && <p className="mt-4 text-red-400">{error}</p>}

      <div className="search-layout">
        <FiltersSidebar filters={filters} onChange={handleFilterApply} />

        <div className="search-main">
          <div className="results-wrapper">
            {/* Spinner — shown only after sweep completes, while still loading */}
            {loading && !sweeping && (
              <div className="results-full-spinner">
                <div className="results-spinner" />
              </div>
            )}

            {/* Cards — hidden after sweep, shown while sweeping out or when done */}
            {(!loading || sweeping) && (
              <div
                key={resultKey}
                className={`results-container${sweeping ? " results-sweep-out" : ""}${!loading && resultKey > 0 ? " results-sweep-in" : ""}`}
              >
                {pageItems.map((item) => (
                  <ListingCard key={`${item.source}:${item.id}`} data={item} />
                ))}
                {!loading && listings.length > 0 && pageItems.length === 0 && (
                  <p className="empty-message">No listings match the current filters.</p>
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
                Page {page}{totalPages > 1 ? ` of ${totalPages}+` : ""}
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

      {!loading && !error && listings.length === 0 && (
        <p className="mt-8 text-gray-400">Enter a search above to begin. Filters are ready whenever you are.</p>
      )}
    </div>
  );
}
