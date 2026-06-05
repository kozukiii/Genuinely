// backend/src/priceSources/stockx.ts
//
// StockX price source. Parallels priceCharting.ts's findPriceChartingMatch:
// given a raw listing title, find the matching StockX product + size variant
// and return its live market spread (lowest ask / highest bid).
//
// StockX prices are per-variant (per size), so we extract a size from the
// title (the sneaker analogue of PriceCharting's grade extraction) and price
// that exact variant, falling back to a product-wide spread when no size is
// found or matched.
import fetch from "node-fetch";
import { getStockXToken, stockxApiKey } from "../services/stockxToken";

const STOCKX_API_BASE = "https://api.stockx.com/v2";
const STOCKX_PRODUCT_BASE = "https://stockx.com";

// Rate-limit outbound StockX calls to the official ~1 req/sec. We gate on
// request *start* times (not a trailing sleep) so a call returns as soon as
// StockX responds — the previous trailing setTimeout added a full second of
// latency to every call on the critical path, which is what made 5-title
// batches blow past Render's request timeout.
const MIN_SPACING_MS = 1000;
const REQUEST_TIMEOUT_MS = 8000; // fail one slow call fast instead of hanging the batch
let _sxGate: Promise<void> = Promise.resolve();
let _lastStart = 0;

/** Serialise scheduling so consecutive request starts are >= MIN_SPACING_MS apart. */
function awaitSlot(): Promise<void> {
  const slot = _sxGate.then(async () => {
    const wait = _lastStart + MIN_SPACING_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    _lastStart = Date.now();
  });
  _sxGate = slot.then(() => undefined, () => undefined);
  return slot;
}

async function sxFetch<T>(pathAndQuery: string): Promise<T> {
  await awaitSlot();
  const token = await getStockXToken();
  const res = await fetch(`${STOCKX_API_BASE}${pathAndQuery}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "x-api-key": stockxApiKey(),
      Accept: "application/json",
    },
    timeout: REQUEST_TIMEOUT_MS,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`StockX ${pathAndQuery} failed: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

type StockXProduct = {
  productId: string;
  urlKey?: string;
  title?: string;
  brand?: string;
  styleId?: string;
};

type StockXVariant = {
  variantId: string;
  variantValue?: string; // the size, e.g. "10", "US 10", "EU 44"
  sizeChart?: { displayOptions?: { size?: string; type?: string }[] };
};

// StockX returns these amounts as either numbers or numeric strings depending
// on the endpoint/version, so the raw shape is number | string. Use toNumber().
type StockXAmount = number | string | null;
type StockXMarketData = {
  lowestAskAmount?: StockXAmount;
  highestBidAmount?: StockXAmount;
  flexLowestAskAmount?: StockXAmount;
  sellFasterAmount?: StockXAmount;
  earnMoreAmount?: StockXAmount;
  currencyCode?: string;
};

/**
 * Extract a US sneaker size from a listing title. Handles "size 10",
 * "sz 10.5", "US 10", "10.5M", "men's 9", and bare trailing sizes.
 * Returns a normalized string ("10", "10.5") or null.
 */
export function extractSize(title: string): string | null {
  const t = title.replace(/\s+/g, " ");

  const patterns: RegExp[] = [
    /\b(?:size|sz)\s*[:#]?\s*(\d{1,2}(?:\.5)?)\b/i,
    /\bus\s*(?:m(?:en'?s)?|w(?:omen'?s)?)?\s*(\d{1,2}(?:\.5)?)\b/i,
    /\b(?:men'?s|mens|wmns|women'?s|womens)\s*(\d{1,2}(?:\.5)?)\b/i,
    /\b(\d{1,2}(?:\.5)?)\s*(?:m\b|men'?s\b|us\b)/i,
  ];

  for (const re of patterns) {
    const m = t.match(re);
    if (m) {
      const n = Number.parseFloat(m[1]);
      if (Number.isFinite(n) && n >= 3 && n <= 18) return normalizeSize(m[1]);
    }
  }
  return null;
}

/** Coerce a StockX amount (number | string | null | undefined) to number|null. */
function toNumber(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeSize(raw: string): string {
  const n = Number.parseFloat(raw);
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/** The size strings a variant could be matched against, normalized. */
function variantSizeTokens(v: StockXVariant): string[] {
  const tokens: string[] = [];
  if (v.variantValue) tokens.push(v.variantValue);
  for (const opt of v.sizeChart?.displayOptions ?? []) {
    if (opt.size) tokens.push(opt.size);
  }
  return tokens
    .map((s) => s.match(/(\d{1,2}(?:\.5)?)/)?.[1])
    .filter((s): s is string => !!s)
    .map(normalizeSize);
}

// Sneaker title noise that carries no product-identity signal — stripped before
// token overlap so e.g. "retro", "mens", condition words don't inflate matches.
const NOISE_TOKENS = new Set([
  "retro", "og", "mens", "men", "mens's", "womens", "women", "wmns", "shoe", "shoes",
  "sneaker", "sneakers", "size", "sz", "us", "ds", "new", "vnds", "basketball",
  "mid", "low", "high", "top", "nubuck", "leather", "the", "and", "a", "ship", "now",
]);

// Kid/youth size markers. StockX encodes these in the product title; an adult
// listing should not match a toddler/preschool product (your "black cat size
// 8.5" → "(TD)" mismatch).
const KID_MARKER_RE = /\b(td|ps|gs|gp|infant|toddler|crib|child|kids?|youth)\b/i;

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9.\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((t) => t && t.length > 1 && !NOISE_TOKENS.has(t));
}

/** Normalize a style id for comparison: strip spaces/dashes, uppercase. */
function normStyle(s: string | undefined | null): string {
  return (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Score how well a StockX product matches a raw listing title. Higher is better.
 * Decisive signal is a style-ID match; otherwise it's token-overlap F1 with a
 * penalty for matching a kids' product against an adult listing.
 */
function scoreProduct(title: string, product: StockXProduct, detectedSize: string | null): number {
  const titleNorm = normStyle(title);
  const styleNorm = normStyle(product.styleId);
  // Style id present verbatim in the title → near-certain match.
  if (styleNorm.length >= 6 && titleNorm.includes(styleNorm)) return 1000;

  const titleTokens = new Set(tokenize(title));
  const prodTokens = new Set(tokenize(product.title ?? ""));
  if (!titleTokens.size || !prodTokens.size) return 0;

  let shared = 0;
  for (const t of prodTokens) if (titleTokens.has(t)) shared++;
  const precision = shared / prodTokens.size;
  const recall = shared / titleTokens.size;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  let score = f1 * 100;

  // Adult listing (size detected, no kid markers) vs a kids' product → penalize.
  const listingIsKids = KID_MARKER_RE.test(title);
  const productIsKids = KID_MARKER_RE.test(product.title ?? "");
  if (productIsKids && !listingIsKids && detectedSize) score -= 50;

  return score;
}

/** Pick the best-scoring product from the search results (was: products[0]). */
function pickBestProduct(
  title: string,
  products: StockXProduct[],
  detectedSize: string | null,
  debugLines: string[]
): StockXProduct | undefined {
  const ranked = products
    .map((p) => ({ p, score: scoreProduct(title, p, detectedSize) }))
    .sort((a, b) => b.score - a.score);
  for (const { p, score } of ranked.slice(0, 5)) {
    debugLines.push(`  candidate score=${score.toFixed(1)}: ${p.title ?? p.productId} (${p.styleId ?? "no style"})`);
  }
  return ranked[0]?.p;
}

export type StockXMatchResult = {
  found: boolean;
  productTitle: string | null;
  productUrl: string | null;
  styleId: string | null;
  size: string | null; // size matched/used for the priced variant
  detectedSize: string | null; // size parsed from the title (may differ if no variant matched)
  lowestAsk: number | null;
  highestBid: number | null;
  currency: string | null;
  debugLines: string[];
};

export async function findStockXMatch(rawTitle: string): Promise<StockXMatchResult> {
  const cleanTitle = rawTitle.trim();
  const debugLines: string[] = [];
  const empty: StockXMatchResult = {
    found: false, productTitle: null, productUrl: null, styleId: null,
    size: null, detectedSize: null, lowestAsk: null, highestBid: null,
    currency: null, debugLines,
  };

  if (!cleanTitle) return empty;
  debugLines.push(`Title: ${cleanTitle}`);

  const detectedSize = extractSize(cleanTitle);
  debugLines.push(`Size detected: ${detectedSize ?? "none"}`);

  // 1) Catalog search
  const search = await sxFetch<{ products?: StockXProduct[] }>(
    `/catalog/search?${new URLSearchParams({ query: cleanTitle, pageNumber: "1", pageSize: "10" })}`
  );
  const products = search.products ?? [];
  debugLines.push(`Search returned ${products.length} products`);
  const product = pickBestProduct(cleanTitle, products, detectedSize, debugLines);
  if (!product) {
    debugLines.push("No product match");
    return { ...empty, detectedSize };
  }

  // Prefer the direct product page (urlKey), but the catalog search response
  // doesn't always include it — fall back to a StockX search by style ID, then
  // by title, so the UI always has a usable link.
  const productUrl = product.urlKey
    ? `${STOCKX_PRODUCT_BASE}/${product.urlKey}`
    : `${STOCKX_PRODUCT_BASE}/search?s=${encodeURIComponent(product.styleId ?? product.title ?? cleanTitle)}`;
  debugLines.push(`Matched product: ${product.title ?? product.productId} (${product.styleId ?? "no style"})`);

  // 2) Variants
  const variants = await sxFetch<StockXVariant[]>(`/catalog/products/${product.productId}/variants`);
  debugLines.push(`Product has ${Array.isArray(variants) ? variants.length : 0} variants`);

  // 3) Pick the variant: exact size match if we detected one, else the first.
  let chosen: StockXVariant | undefined;
  if (detectedSize && Array.isArray(variants)) {
    chosen = variants.find((v) => variantSizeTokens(v).includes(detectedSize));
    debugLines.push(chosen ? `Variant matched for size ${detectedSize}` : `No variant for size ${detectedSize} — falling back to first`);
  }
  if (!chosen && Array.isArray(variants)) chosen = variants[0];

  if (!chosen) {
    debugLines.push("No variants available");
    return {
      ...empty, detectedSize, productTitle: product.title ?? null,
      productUrl, styleId: product.styleId ?? null, found: !!productUrl,
    };
  }

  const usedSize = variantSizeTokens(chosen)[0] ?? chosen.variantValue ?? null;

  // 4) Market data for the chosen variant
  const market = await sxFetch<StockXMarketData>(
    `/catalog/products/${product.productId}/variants/${chosen.variantId}/market-data?${new URLSearchParams({ currencyCode: "USD" })}`
  );
  // StockX returns these amounts as strings in some responses; coerce to a
  // real number (or null) so downstream scoring/formatting can rely on it.
  const lowestAsk = toNumber(market.lowestAskAmount);
  const highestBid = toNumber(market.highestBidAmount);
  debugLines.push(`Size ${usedSize ?? "?"} — lowest ask: ${lowestAsk ?? "n/a"}, highest bid: ${highestBid ?? "n/a"}`);

  return {
    found: true,
    productTitle: product.title ?? null,
    productUrl,
    styleId: product.styleId ?? null,
    size: usedSize,
    detectedSize,
    lowestAsk,
    highestBid,
    currency: market.currencyCode ?? "USD",
    debugLines,
  };
}
