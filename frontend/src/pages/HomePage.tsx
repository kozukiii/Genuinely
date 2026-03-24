import "./styles/HomePage.css";
import { useCallback, useEffect, useMemo, useState } from "react";
import ListingCard from "../components/ListingCard";
import type { Listing } from "../types/Listing";

const API_BASE = "";

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

export default function HomePage() {
  const [bannerTopic, setBannerTopic] = useState<string>("");
  const [bannerItems, setBannerItems] = useState<Listing[]>([]);
  const [gridLabel, setGridLabel] = useState<string>("");
  const [gridItems, setGridItems] = useState<Listing[]>([]);

  const [loadingBanner, setLoadingBanner] = useState(false);
  const [loadingGrid, setLoadingGrid] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const bannerLoopItems = useMemo(() => {
    if (bannerItems.length === 0) return [];
    return [...bannerItems, ...bannerItems];
  }, [bannerItems]);

  const loadBanner = useCallback(async () => {
    const topic = pickRandom(BANNER_TOPICS);
    setBannerTopic(topic);
    setLoadingBanner(true);
    setError(null);

    try {
      const items = await fetchEbay(topic, 10);
      setBannerItems(items);
    } catch (err) {
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      setError(`Banner failed: ${msg}`);
      setBannerItems([]);
    } finally {
      setLoadingBanner(false);
    }
  }, []);

  const loadGrid = useCallback(async () => {
    setLoadingGrid(true);
    setError(null);

    const topics = shuffle(GRID_TOPICS).slice(0, 3);
    setGridLabel(`Mix: ${topics.join(" · ")}`);

    try {
      const chunks = await Promise.all(topics.map((t) => fetchEbay(t, 8)));
      const mixed = shuffle(chunks.flat()).slice(0, 12);
      setGridItems(mixed);
    } catch (err) {
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      setError(`Grid failed: ${msg}`);
      setGridItems([]);
    } finally {
      setLoadingGrid(false);
    }
  }, []);

  const loadAll = useCallback(async () => {
    await Promise.all([loadBanner(), loadGrid()]);
  }, [loadBanner, loadGrid]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  return (
    <div className="home-page">
      <h1 className="logo-title">SmartDeals</h1>
      <p className="tagline">Your AI-powered secondhand marketplace guide.</p>

      <div className="home-actions">
        <span className="home-note">eBay only · analyze=0</span>
      </div>

      {error && <p className="mt-4 text-red-400">{error}</p>}

      <section className="hero-banner">
        <div className="section-head">
          <h2>{bannerTopic ? `Save on ${bannerTopic}` : "Featured Picks"}</h2>
        </div>

        {loadingBanner && <p className="mt-4">Loading banner…</p>}

        {!loadingBanner && bannerItems.length === 0 && (
          <p className="section-empty">No banner items found.</p>
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

      <section className="featured-grid-section">
        <div className="section-head">
          <h2>Featured Deals</h2>
          <p className="section-sub">{gridLabel || "Random mixed products."}</p>
        </div>

        {loadingGrid && <p className="mt-4">Loading grid…</p>}

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