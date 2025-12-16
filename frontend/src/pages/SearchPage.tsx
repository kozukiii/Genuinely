// src/pages/HomePage.tsx
import { useCallback, useEffect, useState } from "react";
import SearchBar from "../components/SearchBar";
import ListingCard from "../components/ListingCard";
import type { Listing } from "../types/Listing";
import "./styles/HomePage.css";


const SEARCH_QUERY_KEY = "search:query";
const SEARCH_LISTINGS_KEY = "search:listings";
const SEARCH_TIMESTAMP_KEY = "search:ts";
const STALE_AFTER_MS = 5 * 60 * 1000; // 5 minutes


export default function HomePage() {
  const [listings, setListings] = useState<Listing[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initialQuery, setInitialQuery] = useState("");

  const fetchListings = useCallback(async (query: string) => {
    if (!query) return;


  
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(
        `http://localhost:3000/api/ebay/overview?query=${encodeURIComponent(
          query
        )}`
      );

      if (!res.ok) throw new Error(`Server responded ${res.status}`);

      const data = await res.json();
      setListings(data);
      sessionStorage.setItem(SEARCH_QUERY_KEY, query);
      sessionStorage.setItem(SEARCH_LISTINGS_KEY, JSON.stringify(data));
      sessionStorage.setItem(SEARCH_TIMESTAMP_KEY, Date.now().toString());





    } catch (err) {
      console.error(err);
      setError("Failed to load listings. Please try again.");
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

      if (savedQuery) {
        setInitialQuery(savedQuery);
      }

      if (savedListingsRaw) {
        const parsed = JSON.parse(savedListingsRaw) as Listing[];
        setListings(parsed);
      }

      const isStale =
        !savedTimestamp || Date.now() - Number(savedTimestamp) > STALE_AFTER_MS;

      if (savedQuery && isStale) {
        fetchListings(savedQuery);
      }
    } catch (err) {
      console.error("Failed to hydrate search data from sessionStorage", err);
    }
  }, [fetchListings]);

  

  return (
    <div className="home-page">
      <SearchBar onSearch={fetchListings} initialQuery={initialQuery} />

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
