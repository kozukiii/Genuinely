import fs from "fs";
import path from "path";
import type { Listing } from "../types/listing";
import { searchEbayNormalized } from "./ebayService";
import { searchMarketplaceListings } from "./marketplaceService";
import { scoreListings } from "./scoring/scoreListing";
import { groupAndContextualize } from "../ai/listingContext";

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

  if (raw.length === 0) {
    console.log("[init] eBay initialization failed");
    throw new Error("No listings fetched for featured");
  }
  console.log("[init] eBay initialized");

  searchMarketplaceListings({ query: "iphone", location: "10001", limit: 1, enrichImages: false })
    .then(() => console.log("[init] Marketplace initialized"))
    .catch(() => console.log("[init] Marketplace initialization failed"));

  // Run the same per-product analysis framework the search path uses: group the
  // listings by exact product, do market research per group (Serper / PriceCharting),
  // then score each group with its own expert system prompt and price range. This is
  // what produces the price-range chart — the legacy flat-context path did not.
  const titles = raw.map((l) => (typeof l.title === "string" ? l.title : ""));
  const groups = await groupAndContextualize(titles, shuffled.join(", ")).catch(() => []);

  const scoredGroups = await Promise.all(
    groups.map(async (group) => {
      const groupListings = group.indices
        .map((index) => raw[index])
        .filter((l): l is Listing => !!l);
      if (groupListings.length === 0) return [] as Listing[];

      const scored = await scoreListings(
        groupListings,
        null,
        group.systemPrompt ?? null,
        group.priceLow ?? null,
        group.priceHigh ?? null,
      );

      // Attach the group's price range / source so the frontend can render the chart,
      // mirroring what /batch-analyze does for the search path.
      return scored.map((listing: any) => ({
        ...listing,
        ...(group.priceLow != null ? { priceLow: group.priceLow } : {}),
        ...(group.priceHigh != null ? { priceHigh: group.priceHigh } : {}),
        ...(group.priceSource ? { priceSource: group.priceSource } : {}),
        ...(group.priceChartingUrl ? { priceChartingUrl: group.priceChartingUrl } : {}),
        ...(group.tcgPlayerUrl ? { tcgPlayerUrl: group.tcgPlayerUrl } : {}),
      }));
    })
  );

  const scored = scoredGroups.flat();

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
