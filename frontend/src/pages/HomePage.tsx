import "./styles/HomePage.css";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import ListingCard from "../components/ListingCard";
import type { Listing } from "../types/Listing";
import { getSavedListings } from "../utils/savedListings";
import { getRecentlyViewed } from "../utils/recentlyViewed";
import { setEbayNotice } from "../utils/ebayNotice";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

const BANNER_TOPICS = [
  "iphone 15",
  "macbook pro",
  "airpods pro",
  "nintendo switch",
  "ps5",
  "rtx 3070",
  "gopro hero",
  "dyson vacuum",
];

const GRID_TOPICS = [
  "mechanical keyboard",
  "gaming chair",
  "monitor 144hz",
  "sony xm4",
  "apple watch",
  "ipad",
  "xbox series s",
  "gpu",
  "camera",
  "golf driver",
  "laptop",
  "headphones",
  "lego",
  "smartphone",
];

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

function pickRandom<T>(arr: T[]) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function shuffle<T>(arr: T[]) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function extractKeyword(listings: Listing[]): string | null {
  if (listings.length === 0) return null;
  const stopWords = new Set(["the", "a", "an", "and", "or", "for", "of", "in", "with", "lot", "set"]);
  for (const listing of shuffle(listings)) {
    const words = listing.title
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3 && !stopWords.has(w));
    if (words.length >= 2) return words.slice(0, 2).join(" ");
    if (words.length === 1) return words[0];
  }
  return null;
}

async function fetchEbay(query: string, limit: number) {
  const url =
    `${API_BASE}/api/search?query=${encodeURIComponent(query)}` +
    `&limit=${limit}&sources=ebay&analyze=0`;

  const res = await fetch(url);
  const text = await res.text();

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} | body: ${text.slice(0, 200)}`);
  }

  const data = JSON.parse(text) as Listing[];
  if (!Array.isArray(data)) throw new Error("Response was not an array");
  return data;
}

async function fetchMarketplace(query: string, limit: number) {
  const url =
    `${API_BASE}/api/search?query=${encodeURIComponent(query)}` +
    `&limit=${limit}&sources=marketplace&analyze=0`;

  const res = await fetch(url);
  const text = await res.text();

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} | body: ${text.slice(0, 200)}`);
  }

  const data = JSON.parse(text) as Listing[];
  if (!Array.isArray(data)) throw new Error("Response was not an array");
  return data;
}

async function fetchHomepageListings(query: string, limit: number) {
  try {
    const ebayItems = await fetchEbay(query, limit);
    if (ebayItems.length > 0) {
      return { items: ebayItems, usedMarketplaceFallback: false };
    }
  } catch {
    // eBay can fail independently, so the homepage should gracefully fall back.
  }

  const marketplaceItems = await fetchMarketplace(query, limit);
  return { items: marketplaceItems, usedMarketplaceFallback: true };
}

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

  const [banner, setBanner] = useState<{ topic: string; items: Listing[] }>({ topic: "", items: [] });
  const [gridLabel, setGridLabel] = useState<string>("");
  const [gridItems, setGridItems] = useState<Listing[]>([]);

  const [savedItems, setSavedItems] = useState<Listing[]>([]);
  const [recentItems, setRecentItems] = useState<Listing[]>([]);
  const [youMayLikeItems, setYouMayLikeItems] = useState<Listing[]>([]);
  const [youMayLikeLabel, setYouMayLikeLabel] = useState("");

  const [loadingBanner, setLoadingBanner] = useState(false);
  const [loadingGrid, setLoadingGrid] = useState(false);
  const [loadingYouMayLike, setLoadingYouMayLike] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bannerUsingFallback, setBannerUsingFallback] = useState(false);
  const [gridUsingFallback, setGridUsingFallback] = useState(false);
  const [youMayLikeUsingFallback, setYouMayLikeUsingFallback] = useState(false);

  const bannerLoopItems = useMemo(() => {
    if (banner.items.length === 0) return [];
    return [...banner.items, ...banner.items];
  }, [banner.items]);

  useEffect(() => {
    setSavedItems(getSavedListings());
    setRecentItems(getRecentlyViewed());

    const onChange = () => {
      setSavedItems(getSavedListings());
    };
    window.addEventListener("saved:listings:changed", onChange);
    return () => window.removeEventListener("saved:listings:changed", onChange);
  }, []);

  useEffect(() => {
    setEbayNotice(bannerUsingFallback || gridUsingFallback || youMayLikeUsingFallback);
  }, [bannerUsingFallback, gridUsingFallback, youMayLikeUsingFallback]);

  useEffect(() => {
    const saved = getSavedListings();
    const keyword = extractKeyword(saved);
    if (!keyword) return;

    setLoadingYouMayLike(true);
    const savedIds = new Set(saved.map((l) => l.id));

    fetchHomepageListings(keyword, 10)
      .then(({ items, usedMarketplaceFallback }) => {
        setYouMayLikeUsingFallback(usedMarketplaceFallback);
        const filtered = items.filter((l) => !savedIds.has(l.id));
        setYouMayLikeItems(filtered.slice(0, 8));
        setYouMayLikeLabel(keyword);
      })
      .catch(() => {})
      .finally(() => setLoadingYouMayLike(false));
  }, []);

  const loadBanner = useCallback(async () => {
    const topic = pickRandom(BANNER_TOPICS);
    setLoadingBanner(true);
    setError(null);

    try {
      const { items, usedMarketplaceFallback } = await fetchHomepageListings(topic, 10);
      setBannerUsingFallback(usedMarketplaceFallback);
      setBanner({ topic, items });
    } catch (err) {
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      setError(`Banner failed: ${msg}`);
      setBanner({ topic, items: [] });
    } finally {
      setLoadingBanner(false);
    }
  }, []);

  const loadGrid = useCallback(async () => {
    setLoadingGrid(true);
    setError(null);

    const topics = shuffle(GRID_TOPICS).slice(0, 3);
    setGridLabel(topics.join(" / "));

    try {
      const chunks = await Promise.all(topics.map((t) => fetchHomepageListings(t, 8)));
      setGridUsingFallback(chunks.some((chunk) => chunk.usedMarketplaceFallback));
      const mixed = shuffle(chunks.flatMap((chunk) => chunk.items)).slice(0, 12);
      setGridItems(mixed);
    } catch (err) {
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      setError(`Grid failed: ${msg}`);
      setGridItems([]);
    } finally {
      setLoadingGrid(false);
    }
  }, []);

  useEffect(() => {
    void Promise.all([loadBanner(), loadGrid()]);
  }, [loadBanner, loadGrid]);

  function goToSearch(query: string) {
    sessionStorage.setItem("search:query", query);
    navigate("/search");
  }

  return (
    <div className="home-page">
      <h1 className="logo-title">SmartDeals</h1>
      <p className="tagline">Your AI-powered secondhand marketplace guide.</p>

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

      {error && <p className="mt-4 text-red-400">{error}</p>}

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
          <p className="section-empty">
            Save listings while browsing and they'll appear here.
          </p>
        ) : (
          <HorizontalShelf items={savedItems} />
        )}
      </section>

      {(loadingYouMayLike || youMayLikeItems.length > 0) && (
        <section className="home-section">
          <div className="section-head">
            <h2>You May Like</h2>
            {youMayLikeLabel && (
              <p className="section-sub">Based on your saves for "{youMayLikeLabel}"</p>
            )}
          </div>

          {loadingYouMayLike && <p className="section-empty">Loading...</p>}

          {!loadingYouMayLike && youMayLikeItems.length > 0 && (
            <HorizontalShelf items={youMayLikeItems} />
          )}
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
          <h2>{banner.topic ? `Save on ${banner.topic}` : "Featured Picks"}</h2>
        </div>

        {loadingBanner && <p className="section-empty">Loading...</p>}

        {!loadingBanner && banner.items.length === 0 && (
          <p className="section-empty">No banner items found.</p>
        )}

        {banner.items.length > 0 && (
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

      <section className="featured-grid-section">
        <div className="section-head">
          <h2>Featured Deals</h2>
          <p className="section-sub">{gridLabel || "Random mixed products."}</p>
        </div>

        {loadingGrid && <p className="section-empty">Loading...</p>}

        {!loadingGrid && gridItems.length === 0 && (
          <p className="section-empty">No grid items found.</p>
        )}

        {gridItems.length > 0 && (
          <div className="featured-grid">
            {gridItems.map((item) => (
              <ListingCard key={`${item.source}:${item.id}`} data={item} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
