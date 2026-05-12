import { useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import "./styles/AdminPage.css";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

type SoldPriceListing = {
  itemId: string;
  title: string;
  price: number | null;
  currency: string;
  soldDate?: string;
  condition?: string;
  url?: string;
};

type SoldPriceResult = {
  query: string;
  lowPrice: number | null;
  highPrice: number | null;
  averagePrice: number | null;
  medianPrice: number | null;
  currency: string | null;
  sampleSize: number;
  total: number | null;
  ignoredCurrencyCount: number;
  listings: SoldPriceListing[];
  priceChartingUrl?: string | null;
  tcgPlayerUrl?: string | null;
};

function formatMoney(value: number | null, currency: string | null) {
  if (value == null) return "N/A";

  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency ?? "USD",
    }).format(value);
  } catch {
    return `$${value.toFixed(2)}`;
  }
}

export default function EbaySoldPricesPage() {
  const { user, loading } = useAuth();
  const [term, setTerm] = useState("");
  const [result, setResult] = useState<SoldPriceResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSearching, setIsSearching] = useState(false);

  const resultCurrency = result?.currency ?? "USD";
  const priceStats = useMemo(() => {
    if (!result) return [];

    const looseListing = result.listings.find(
      (listing) => String(listing.condition ?? "").toLowerCase() === "loose"
    );
    const tcgPlayerListing = result.listings.find(
      (listing) => String(listing.condition ?? "").toLowerCase() === "tcgplayer"
    );

    return [
      { label: "Low", value: formatMoney(result.lowPrice, resultCurrency) },
      { label: "High", value: formatMoney(result.highPrice, resultCurrency) },
      { label: "Loose", value: formatMoney(looseListing?.price ?? null, resultCurrency) },
      { label: "TCGPlayer", value: formatMoney(tcgPlayerListing?.price ?? null, resultCurrency) },
    ];
  }, [result, resultCurrency]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const query = term.trim();
    if (!query) return;

    setIsSearching(true);
    setError(null);
    setResult(null);

    try {
      const params = new URLSearchParams({ query, limit: "50" });
      const response = await fetch(`${API_BASE}/api/internal/ebay/sold-prices?${params}`, {
        credentials: "include",
      });
      const data = await response.json();

      if (!response.ok) {
      throw new Error(data.error ?? `Request failed with ${response.status}`);
      }

      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch current market prices");
    } finally {
      setIsSearching(false);
    }
  }

  if (loading) return null;

  if (!user?.isAdmin) {
    return (
      <main className="admin-page">
        <p className="admin-forbidden">403 - Forbidden</p>
      </main>
    );
  }

  return (
    <main className="admin-page">
      <Link to="/admin" className="admin-back-link">Back to admin</Link>
      <h1 className="admin-heading">PriceCharting Market Price Lookup</h1>

      <section className="admin-section admin-tool-panel">
        <form className="admin-search-form" onSubmit={handleSubmit}>
          <label className="admin-field-label" htmlFor="sold-price-term">
            Search term
          </label>
          <div className="admin-search-row">
            <input
              id="sold-price-term"
              className="admin-text-input"
              type="text"
              value={term}
              onChange={(event) => setTerm(event.target.value)}
              placeholder="iPhone 14 Pro 128GB unlocked"
              autoComplete="off"
            />
            <button className="admin-primary-button" type="submit" disabled={isSearching || !term.trim()}>
              {isSearching ? "Searching..." : "Get prices"}
            </button>
          </div>
        </form>
      </section>

      {error && (
        <section className="admin-section">
          <p className="admin-error">{error}</p>
        </section>
      )}

      {result && (
        <section className="admin-section">
          <div className="admin-result-header">
            <div>
              <h2 className="admin-subheading">Current Market Prices</h2>
              <p className="admin-card-note">
                PriceCharting loose price vs TCGPlayer
                {result.total != null ? ` from ${result.total.toLocaleString()} total market rows` : ""}
                {result.ignoredCurrencyCount > 0 ? `, ${result.ignoredCurrencyCount} skipped for mixed currency` : ""}
              </p>
            </div>
            <span className="admin-status admin-status--ok">{result.currency ?? "No currency"}</span>
          </div>

          <div className="admin-price-grid">
            {priceStats.map((stat) => (
              <div key={stat.label} className="admin-price-stat">
                <span className="admin-price-label">{stat.label}</span>
                <span className="admin-price-value">{stat.value}</span>
              </div>
            ))}
          </div>

          {(result.priceChartingUrl || result.tcgPlayerUrl) && (
            <div className="admin-sold-list">
              {result.priceChartingUrl && (
                <a
                  className="admin-sold-row"
                  href={result.priceChartingUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  <span className="admin-sold-title">PriceCharting source</span>
                  <span className="admin-sold-meta">Open source page</span>
                </a>
              )}
              {result.tcgPlayerUrl && (
                <a
                  className="admin-sold-row"
                  href={result.tcgPlayerUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  <span className="admin-sold-title">TCGPlayer source</span>
                  <span className="admin-sold-meta">Open source page</span>
                </a>
              )}
            </div>
          )}

          {result.listings.length > 0 && (
            <div className="admin-sold-list">
              {result.listings
                .filter((listing) => {
                  const condition = String(listing.condition ?? "").toLowerCase();
                  return condition === "loose" || condition === "tcgplayer";
                })
                .map((listing) => (
                <a
                  key={`${listing.itemId}-${listing.price}`}
                  className="admin-sold-row"
                  href={listing.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  <span className="admin-sold-title">{listing.title}</span>
                  <span className="admin-sold-meta">
                    {listing.condition ? `${listing.condition} | ` : ""}
                    {formatMoney(listing.price, listing.currency)}
                  </span>
                </a>
              ))}
            </div>
          )}
        </section>
      )}
    </main>
  );
}
