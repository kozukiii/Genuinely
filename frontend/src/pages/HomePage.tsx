// src/pages/HomePage.tsx
import { useState } from "react";
import SearchBar from "../components/SearchBar";
import ListingCard from "../components/ListingCard";
import type { Listing } from "../types/Listing";
import "./styles/HomePage.css";




export default function HomePage() {
  const [listings, setListings] = useState<Listing[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function fetchListings(query: string) {
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
    } catch (err) {
      console.error(err);
      setError("Failed to load listings. Please try again.");
      setListings([]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="home-page">
      <SearchBar onSearch={fetchListings} />

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
