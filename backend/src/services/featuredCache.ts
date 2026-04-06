import fs from "fs";
import path from "path";
import type { Listing } from "../types/listing";
import { searchEbayNormalized } from "./ebayService";
import { scoreListings } from "./scoring/scoreListing";
import { fetchMarketContext } from "../ai/priceContext";

const CACHE_PATH = path.join(process.env.DATA_DIR ?? path.join(process.cwd(), "data"), "featured.json");
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const FEATURED_TOPICS = [
  "iphone",
  "macbook",
  "ps5",
  "nintendo switch",
  "airpods",
  "rtx gpu",
  "sony headphones",
  "apple watch",
];

interface FeaturedCache {
  generatedAt: string;
  listings: Listing[];
}

let refreshing = false;

function readCache(): FeaturedCache | null {
  try {
    const raw = fs.readFileSync(CACHE_PATH, "utf-8");
    return JSON.parse(raw) as FeaturedCache;
  } catch {
    return null;
  }
}

function writeCache(data: FeaturedCache) {
  try {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(data), "utf-8");
  } catch (err) {
    console.error("[featured] Failed to write cache:", err);
  }
}

function isStale(cache: FeaturedCache): boolean {
  return Date.now() - new Date(cache.generatedAt).getTime() > TTL_MS;
}

async function buildFeatured(): Promise<FeaturedCache> {
  console.log("[featured] Building featured listings…");

  // Pick 3 random topics, fetch 5 listings each, score them all
  const shuffled = [...FEATURED_TOPICS].sort(() => Math.random() - 0.5).slice(0, 3);

  const chunks = await Promise.allSettled(
    shuffled.map((topic) => searchEbayNormalized(topic, 5, null, undefined, undefined, undefined, 0))
  );

  const raw: Listing[] = chunks.flatMap((r) => (r.status === "fulfilled" ? r.value : []));

  if (raw.length === 0) throw new Error("No listings fetched for featured");

  const context = await fetchMarketContext(shuffled.join(", ")).catch(() => null);
  const scored = await scoreListings(raw, context);

  // Only keep listings that actually got a score
  const withScores = scored.filter((l) => l.aiScore != null);

  return {
    generatedAt: new Date().toISOString(),
    listings: withScores,
  };
}

function triggerRefresh() {
  if (refreshing) return;
  refreshing = true;

  buildFeatured()
    .then(writeCache)
    .catch((err) => console.error("[featured] Refresh failed:", err))
    .finally(() => { refreshing = false; });
}

export function getFeatured(): { listings: Listing[]; generatedAt: string | null; refreshing: boolean } {
  const cache = readCache();

  if (!cache) {
    // Nothing cached yet — kick off a build, return empty for now
    triggerRefresh();
    return { listings: [], generatedAt: null, refreshing: true };
  }

  if (isStale(cache)) {
    // Return stale data immediately, refresh in background
    triggerRefresh();
  }

  return { listings: cache.listings, generatedAt: cache.generatedAt, refreshing };
}
