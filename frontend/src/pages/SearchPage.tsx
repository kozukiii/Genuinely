import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigationType } from "react-router-dom";
import SearchBar from "../components/SearchBar";
import ListingCard from "../components/ListingCard";
import type { Listing } from "../types/Listing";
import "./styles/HomePage.css";

const SEARCH_QUERY_KEY = "search:query";
const SEARCH_LISTINGS_KEY = "search:listings";
const SEARCH_TIMESTAMP_KEY = "search:ts";

// NEW
const SEARCH_LIMIT_KEY = "search:limit";

const API_BASE = "";

const LIMIT_MIN = 1;
const LIMIT_MAX = 64;

function clampInt(n: number, min: number, max: number) {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

// UPDATED: hydrate also loads limit (optional)
function hydrateSearch(
  setInitialQuery: (s: string) => void,
  setListings: (l: Listing[]) => void,
  setLimitText: (s: string) => void
) {
  try {
    const savedQuery = sessionStorage.getItem(SEARCH_QUERY_KEY) ?? "";
    const savedListingsRaw = sessionStorage.getItem(SEARCH_LISTINGS_KEY);

    // NEW
    const savedLimit = sessionStorage.getItem(SEARCH_LIMIT_KEY);

    if (savedQuery) setInitialQuery(savedQuery);

    if (savedLimit) setLimitText(savedLimit);

    if (savedListingsRaw) {
      const parsed = JSON.parse(savedListingsRaw) as Listing[];
      if (Array.isArray(parsed)) setListings(parsed);
    }
  } catch (err) {
    console.error("Failed to hydrate search data from sessionStorage", err);
  }
}

export default function SearchPage() {
  const navType = useNavigationType();

  const [demoMode, setDemoMode] = useState(true);
  const [listings, setListings] = useState<Listing[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initialQuery, setInitialQuery] = useState("");

  // NEW: limit textbox state (string so user can type freely)
  const [limitText, setLimitText] = useState<string>("64");

  // NEW: computed, clamped limit used for requests
  const limit = useMemo(() => {
    const n = Number(limitText);
    if (!Number.isFinite(n)) return 64;
    return clampInt(n, LIMIT_MIN, LIMIT_MAX);
  }, [limitText]);

  const fetchListings = useCallback(
    async (query: string) => {
      const q = query.trim();
      if (!q) return;

      setLoading(true);
      setError(null);

      const url =
        `${API_BASE}/api/search?query=${encodeURIComponent(q)}` +
        `&limit=${limit}&sources=ebay,marketplace` +
        `&analyze=${demoMode ? "0" : "1"}`;


      try {
        const res = await fetch(url);
        const text = await res.text();

        if (!res.ok) {
          throw new Error(`HTTP ${res.status} ${res.statusText} | body: ${text.slice(0, 200)}`);
        }

        const data = JSON.parse(text) as Listing[];
        if (!Array.isArray(data)) throw new Error("Response was not an array");

        setListings(data);

        // ✅ persist query + listings + limit
        sessionStorage.setItem(SEARCH_QUERY_KEY, q);
        sessionStorage.setItem(SEARCH_LISTINGS_KEY, JSON.stringify(data));
        sessionStorage.setItem(SEARCH_TIMESTAMP_KEY, Date.now().toString());
        sessionStorage.setItem(SEARCH_LIMIT_KEY, String(limit));
      } catch (err) {
        const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        setError(`Failed to load listings: ${msg}`);
      } finally {
        setLoading(false);
      }
    },
    [demoMode, limit]
  );

  // Initial mount hydration
  useEffect(() => {
    hydrateSearch(setInitialQuery, setListings, setLimitText);
  }, []);

  // When user hits Back/Forward (POP), rehydrate again
  useEffect(() => {
    if (navType === "POP") {
      hydrateSearch(setInitialQuery, setListings, setLimitText);
    }
  }, [navType]);

  // ...everything above stays the same

return (
  <div className="home-page">
    <SearchBar onSearch={fetchListings} initialQuery={initialQuery} />

    <div className="search-controls">
      <label className="demo-toggle">
        <input
          type="checkbox"
          checked={demoMode}
          onChange={(e) => setDemoMode(e.target.checked)}
        />
        Demo mode
      </label>

      <label className="limit-control">
        <span className="limit-label">Limit</span>
        <input
          className="limit-input"
          type="number"
          min={LIMIT_MIN}
          max={LIMIT_MAX}
          step={1}
          value={limitText}
          onChange={(e) => setLimitText(e.target.value)}
          onBlur={() => setLimitText(String(limit))}
        />
        <span className="limit-hint">(1–64)</span>
      </label>

    </div>

    {loading && <p className="mt-4">Loading results...</p>}
    {error && <p className="mt-4 text-red-400">{error}</p>}

    <div className="results-container">
      {listings.map((item) => (
        <ListingCard key={`${item.source}:${item.id}`} data={item} />
      ))}
    </div>

    {!loading && !error && listings.length === 0 && (
      <p className="mt-8 text-gray-400">Enter a search above to begin.</p>
    )}
  </div>
);
}
