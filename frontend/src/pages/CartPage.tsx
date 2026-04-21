import { useEffect, useMemo, useState } from "react";
import { Helmet } from "react-helmet-async";
import ListingCard from "../components/ListingCard";
import type { Listing } from "../types/Listing";
import { getSavedListings, setSavedListings } from "../utils/savedListings";
import "./styles/HomePage.css";
import "./styles/CartPage.css";



export default function CartPage() {
  const [saved, setSaved] = useState<Listing[]>([]);
  const [query, setQuery] = useState("");

  useEffect(() => {
    const load = () => setSaved(getSavedListings());
    load();

    window.addEventListener("saved:listings:changed", load);
    return () => window.removeEventListener("saved:listings:changed", load);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return saved;

    return saved.filter((x) => {
      const title = x.title?.toLowerCase() ?? "";
      const seller = x.seller?.toLowerCase() ?? "";
      return title.includes(q) || seller.includes(q);
    });
  }, [saved, query]);

  const counts = useMemo(() => {
    const ebay = saved.filter((x) => x.source === "ebay").length;
    const marketplace = saved.filter((x) => x.source === "marketplace").length;
    return { total: saved.length, ebay, marketplace };
  }, [saved]);

  function clearAll() {
    if (saved.length === 0) return;
    if (!confirm("Clear all saved listings?")) return;
    setSavedListings([]);
    setSaved([]);
  }

  return (
    <div className="home-page">
      <Helmet>
        <title>Saved Items | Genuinely</title>
        <meta name="description" content="Your saved eBay and Facebook Marketplace listings, all in one place." />
      </Helmet>
      <div className="cart-header">
        <div className="cart-title-row">
          <h1 className="cart-title">Saved</h1>

          <div className="cart-meta">
            <span>{counts.total} total</span>
            <span className="dot">•</span>
            <span>{counts.ebay} eBay</span>
            <span className="dot">•</span>
            <span>{counts.marketplace} Marketplace</span>
          </div>
        </div>

        <div className="cart-controls">
          <input
            className="cart-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search saved…"
            aria-label="Search saved listings"
          />

          <button
            type="button"
            className="cart-clear"
            onClick={clearAll}
            disabled={saved.length === 0}
            title={saved.length === 0 ? "No saved listings" : "Clear all"}
          >
            Clear
          </button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="cart-empty">
          <div className="cart-empty-card">
            <div className="cart-empty-title">No saved listings</div>
            <div className="cart-empty-sub">
              Hit the heart on a listing to save it here.
            </div>
          </div>
        </div>
      ) : (
        // ✅ EXACT same container class used on SearchPage
        <div className="results-container">
          {filtered.map((listing) => (
            <ListingCard key={`${listing.source}:${listing.id}`} data={listing} />
          ))}
        </div>
      )}
    </div>
  );
}
