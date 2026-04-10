import "./styles/HomePage.css";
import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import ListingCard from "../components/ListingCard";
import type { Listing } from "../types/Listing";
import { getSavedListings } from "../utils/savedListings";
import { getRecentlyViewed } from "../utils/recentlyViewed";
import { setEbayNotice } from "../utils/ebayNotice";
import { getSearchCache } from "../utils/searchCache";


const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

const CATEGORIES = [
  { label: "Trading Cards", query: "trading cards" },
  { label: "PS5", query: "ps5" },
  { label: "Xbox", query: "xbox series x" },
  { label: "Sneakers", query: "sneakers" },
  { label: "iPhone", query: "iphone" },
  { label: "MacBook", query: "macbook" },
  { label: "GPU", query: "graphics card" },
  { label: "Headphones", query: "headphones" },
  { label: "Lego", query: "lego" },
  { label: "Camera", query: "camera" },
  { label: "Nintendo Switch", query: "nintendo switch" },
  { label: "Watches", query: "watch" },
];


function HorizontalShelf({ items }: { items: Listing[] }) {
  return (
    <div className="shelf-scroll">
      {items.map((item, idx) => (
        <div className="shelf-card" key={`${item.source}:${item.id}:${idx}`}>
          <ListingCard data={item} />
        </div>
      ))}
    </div>
  );
}

export default function HomePage() {
  const navigate = useNavigate();

  const [featuredListings, setFeaturedListings] = useState<Listing[]>([]);
  const [featuredGeneratedAt, setFeaturedGeneratedAt] = useState<string | null>(null);
  const [loadingFeatured, setLoadingFeatured] = useState(true);

  const [savedItems, setSavedItems] = useState<Listing[]>([]);
  const [recentItems, setRecentItems] = useState<Listing[]>([]);

  const [heroQuery, setHeroQuery] = useState("");

  const bannerLoopItems = useMemo(() => {
    if (featuredListings.length === 0) return [];
    return [...featuredListings, ...featuredListings];
  }, [featuredListings]);

  // Saved + recently viewed
  useEffect(() => {
    setSavedItems(getSavedListings());
    setRecentItems(getRecentlyViewed());

    const onChange = () => setSavedItems(getSavedListings());
    window.addEventListener("saved:listings:changed", onChange);
    return () => window.removeEventListener("saved:listings:changed", onChange);
  }, []);

  // Featured listings from persistent cache
  useEffect(() => {
    setLoadingFeatured(true);
    fetch(`${API_BASE}/api/featured`)
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data.listings)) {
          setFeaturedListings(data.listings);
          setFeaturedGeneratedAt(data.generatedAt ?? null);
        }
        // If the cache is still being built (refreshing: true, listings: []),
        // poll once after 30s to pick up the first run
        if (data.refreshing && (!data.listings || data.listings.length === 0)) {
          setTimeout(() => {
            fetch(`${API_BASE}/api/featured`)
              .then((r) => r.json())
              .then((d) => {
                if (Array.isArray(d.listings) && d.listings.length > 0) {
                  setFeaturedListings(d.listings);
                  setFeaturedGeneratedAt(d.generatedAt ?? null);
                }
              })
              .catch(() => {});
          }, 30_000);
        }
      })
      .catch(() => {})
      .finally(() => setLoadingFeatured(false));
  }, []);

  // eBay notice: if featured is empty after loading, assume eBay may be down
  useEffect(() => {
    if (!loadingFeatured && featuredListings.length === 0) {
      setEbayNotice(true);
    } else {
      setEbayNotice(false);
    }
  }, [loadingFeatured, featuredListings.length]);

  // "You May Like" — scored search cache listings that keyword-match saved items
  const youMayLikeItems = useMemo(() => {
    if (savedItems.length === 0) return null;

    const stopWords = new Set(["the", "a", "an", "and", "or", "for", "of", "in", "with", "lot", "set"]);
    const keywords = new Set(
      savedItems.flatMap((l) =>
        l.title
          .toLowerCase()
          .replace(/[^a-z0-9 ]/g, " ")
          .split(/\s+/)
          .filter((w) => w.length > 3 && !stopWords.has(w))
      )
    );

    if (keywords.size === 0) return null;

    const savedIds = new Set(savedItems.map((l) => `${l.source}:${l.id}`));
    const pool = getSearchCache();
    if (pool.length === 0) return null;

    const matches = pool.filter((l) => {
      if (savedIds.has(`${l.source}:${l.id}`)) return false;
      const words = l.title.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/);
      return words.some((w) => keywords.has(w));
    });

    return matches.length > 0 ? matches : null;
  }, [savedItems]);

  function goToSearch(query: string) {
    sessionStorage.setItem("search:query", query);
    navigate("/search");
  }

  function submitHeroSearch(e: React.FormEvent) {
    e.preventDefault();
    const q = heroQuery.trim();
    if (!q) return;
    goToSearch(q);
  }

  // Split featured into banner (marquee) + grid
  const bannerItems = featuredListings.slice(0, 8);
  const gridItems = featuredListings;

  const featuredAge = featuredGeneratedAt
    ? Math.round((Date.now() - new Date(featuredGeneratedAt).getTime()) / (1000 * 60 * 60))
    : null;

  return (
    <div className="home-page">
      <section className="home-hero">
        <div className="home-hero-top">
          <div className="home-hero-logo">
            <svg viewBox="0 0 56 56" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <defs>
                <linearGradient id="heroRingGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#3dff8f" />
                  <stop offset="100%" stopColor="#1aad54" />
                </linearGradient>
              </defs>
              <circle cx="28" cy="28" r="23" stroke="url(#heroRingGrad)" strokeWidth="4" />
              <text x="28" y="37" textAnchor="middle" fill="white" fontFamily="system-ui,-apple-system,sans-serif" fontWeight="700" fontSize="26">G</text>
            </svg>
          </div>

          <h1 className="home-hero-wordmark">GENUINELY</h1>
          <p className="home-hero-sub">The secondhand market, analyzed.</p>
        </div>

        <form className="home-hero-search" onSubmit={submitHeroSearch}>
          <input
            className="home-hero-input"
            type="text"
            placeholder="Search for anything…"
            value={heroQuery}
            onChange={(e) => setHeroQuery(e.target.value)}
            aria-label="Search listings"
          />
          <button className="home-hero-btn" type="submit">Search</button>
        </form>

        <div className="category-pills">
          {CATEGORIES.map((cat) => (
            <button
              key={cat.query}
              className="category-pill"
              onClick={() => goToSearch(cat.query)}
            >
              {cat.label}
            </button>
          ))}
        </div>
      </section>

      <section className="home-section">
        <div className="section-head">
          <h2>
            Your Saved Items
            {savedItems.length > 0 && (
              <span className="section-count">{savedItems.length}</span>
            )}
          </h2>
        </div>
        {savedItems.length === 0 ? (
          <p className="section-empty">Save listings while browsing and they'll appear here.</p>
        ) : (
          <HorizontalShelf items={savedItems} />
        )}
      </section>

      {youMayLikeItems && (
        <section className="home-section">
          <div className="section-head">
            <h2>You May Like</h2>
          </div>
          <HorizontalShelf items={youMayLikeItems} />
        </section>
      )}

      {recentItems.length > 0 && (
        <section className="home-section">
          <div className="section-head">
            <h2>Recently Viewed</h2>
          </div>
          <HorizontalShelf items={recentItems} />
        </section>
      )}

      <section className="hero-banner">
        <div className="section-head">
          <h2>Featured Picks</h2>
          {featuredAge !== null && (
            <p className="section-sub">Updated {featuredAge === 0 ? "just now" : `${featuredAge}h ago`}</p>
          )}
        </div>

        {loadingFeatured && <p className="section-empty">Loading…</p>}

        {!loadingFeatured && bannerItems.length === 0 && (
          <p className="section-empty">Preparing featured listings — check back shortly.</p>
        )}

        {bannerItems.length > 0 && (
          <div className="banner-viewport" aria-label="Featured banner carousel">
            <div className="banner-track">
              {bannerLoopItems.map((item, idx) => (
                <div className="banner-card" key={`${item.source}:${item.id}:${idx}`}>
                  <ListingCard data={item} />
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      {gridItems.length > 0 && (
        <section className="featured-grid-section">
          <div className="section-head">
            <h2>Today's Deals</h2>
            <p className="section-sub">AI-scored and ready to browse</p>
          </div>
          <div className="featured-grid">
            {gridItems.map((item) => (
              <ListingCard key={`${item.source}:${item.id}`} data={item} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
