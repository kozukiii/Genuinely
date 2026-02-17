// src/pages/SearchPage.tsx
import { useCallback, useEffect, useState } from "react";
import SearchBar from "../components/SearchBar";
import ListingCard from "../components/ListingCard";
import type { Listing } from "../types/Listing";
import "./styles/HomePage.css";

const SEARCH_QUERY_KEY = "search:query";
const SEARCH_LISTINGS_KEY = "search:listings";
const SEARCH_TIMESTAMP_KEY = "search:ts";
const STALE_AFTER_MS = 30 * 60 * 1000; // 5 minutes

// ✅ With Vite proxy enabled, keep API calls same-origin
// vite.config.ts proxies /api -> http://localhost:3000
const API_BASE = "";

export default function SearchPage() {
  const [listings, setListings] = useState<Listing[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initialQuery, setInitialQuery] = useState("");

  const fetchListings = useCallback(async (query: string) => {
    if (!query) {
      setError('DEBUG: empty query (not fetching)');
      return;
    }

    setLoading(true);

    const url = `${API_BASE}/api/ebay/overview?query=${encodeURIComponent(query)}`;
    setError(`DEBUG: requesting ${url}`);

    try {
      const res = await fetch(url);

      // Read raw first so we can surface useful errors on mobile
      const text = await res.text();

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText} | body: ${text.slice(0, 200)}`);
      }

      let data: Listing[];
      try {
        data = JSON.parse(text) as Listing[];
      } catch {
        throw new Error(`JSON parse failed | body starts: ${text.slice(0, 200)}`);
      }

      setListings(data);

      sessionStorage.setItem(SEARCH_QUERY_KEY, query);
      sessionStorage.setItem(SEARCH_LISTINGS_KEY, JSON.stringify(data));
      sessionStorage.setItem(SEARCH_TIMESTAMP_KEY, Date.now().toString());

      setError(null); // clear only on success
    } catch (err) {
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      setError(`Failed to load listings: ${msg}`);

      setListings([]);
      sessionStorage.removeItem(SEARCH_QUERY_KEY);
      sessionStorage.removeItem(SEARCH_LISTINGS_KEY);
      sessionStorage.removeItem(SEARCH_TIMESTAMP_KEY);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    try {
      const savedQuery = sessionStorage.getItem(SEARCH_QUERY_KEY) ?? "";
      const savedListingsRaw = sessionStorage.getItem(SEARCH_LISTINGS_KEY);
      const savedTimestamp = sessionStorage.getItem(SEARCH_TIMESTAMP_KEY);

      if (savedQuery) setInitialQuery(savedQuery);

      if (savedListingsRaw) {
        const parsed = JSON.parse(savedListingsRaw) as Listing[];
        setListings(parsed);
      }

      const isStale =
        !savedTimestamp || Date.now() - Number(savedTimestamp) > STALE_AFTER_MS;

      if (savedQuery && isStale) fetchListings(savedQuery);
    } catch (err) {
      console.error("Failed to hydrate search data from sessionStorage", err);
    }
  }, [fetchListings]);

  return (
    <div className="home-page">
      <SearchBar onSearch={fetchListings} initialQuery={initialQuery} />

      {/* Quick sanity: should show blank (same-origin). Requests go through Vite proxy */}
      <p style={{ fontSize: 12, opacity: 0.7 }}>API_BASE: {API_BASE || "(same-origin / vite proxy)"}</p>

      {loading && <p className="mt-4">Loading results...</p>}
      {error && <p className="mt-4 text-red-400">{error}</p>}

      <div className="results-container">
        {listings.map((item, i) => (
          <ListingCard key={i} data={item} />
        ))}
      </div>

      {!loading && !error && listings.length === 0 && (
        <p className="mt-8 text-gray-400">Enter a search above to begin.</p>
      )}
    </div>
  );
}
