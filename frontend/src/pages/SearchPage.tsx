import { useCallback, useEffect, useState } from "react";
import { useNavigationType } from "react-router-dom";
import SearchBar from "../components/SearchBar";
import ListingCard from "../components/ListingCard";
import type { Listing } from "../types/Listing";
import "./styles/HomePage.css";

const SEARCH_QUERY_KEY = "search:query";
const SEARCH_LISTINGS_KEY = "search:listings";
const SEARCH_TIMESTAMP_KEY = "search:ts";

const API_BASE = "";

function hydrateSearch(setInitialQuery: (s: string) => void, setListings: (l: Listing[]) => void) {
  try {
    const savedQuery = sessionStorage.getItem(SEARCH_QUERY_KEY) ?? "";
    const savedListingsRaw = sessionStorage.getItem(SEARCH_LISTINGS_KEY);

    if (savedQuery) setInitialQuery(savedQuery);

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
  const [debug, setDebug] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [initialQuery, setInitialQuery] = useState("");

  const fetchListings = useCallback(
    async (query: string) => {
      const q = query.trim();
      if (!q) return;

      setLoading(true);
      setError(null);

      const url =
        `${API_BASE}/api/search?query=${encodeURIComponent(q)}` +
        `&limit=64&sources=ebay,marketplace` +
        `&analyze=${demoMode ? "0" : "1"}`;

      setDebug(`requesting ${url}`);

      try {
        const res = await fetch(url);
        const text = await res.text();

        if (!res.ok) {
          throw new Error(`HTTP ${res.status} ${res.statusText} | body: ${text.slice(0, 200)}`);
        }

        const data = JSON.parse(text) as Listing[];
        if (!Array.isArray(data)) throw new Error("Response was not an array");

        setListings(data);

        // ✅ persist both query + listings
        sessionStorage.setItem(SEARCH_QUERY_KEY, q);
        sessionStorage.setItem(SEARCH_LISTINGS_KEY, JSON.stringify(data));
        sessionStorage.setItem(SEARCH_TIMESTAMP_KEY, Date.now().toString());
      } catch (err) {
        const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        setError(`Failed to load listings: ${msg}`);

        // ✅ DO NOT clear listings on error (prevents “Back = blank”)
        // ✅ DO NOT remove sessionStorage on error
      } finally {
        setLoading(false);
      }
    },
    [demoMode]
  );

  // Initial mount hydration
  useEffect(() => {
    hydrateSearch(setInitialQuery, setListings);
  }, []);

  // When user hits Back/Forward (POP), rehydrate again
  useEffect(() => {
    if (navType === "POP") {
      hydrateSearch(setInitialQuery, setListings);
    }
  }, [navType]);

  return (
    <div className="home-page">
      <SearchBar onSearch={fetchListings} initialQuery={initialQuery} />

      <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 10 }}>
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="checkbox"
            checked={demoMode}
            onChange={(e) => setDemoMode(e.target.checked)}
          />
          Demo mode 
        </label>

        <p style={{ fontSize: 12, opacity: 0.7 }}>
          API_BASE: {API_BASE || "(same-origin / vite proxy)"}
        </p>
      </div>

      {loading && <p className="mt-4">Loading results...</p>}
      {error && <p className="mt-4 text-red-400">{error}</p>}
      {debug && <p className="mt-2" style={{ fontSize: 12, opacity: 0.7 }}>{debug}</p>}

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
