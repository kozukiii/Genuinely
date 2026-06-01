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

// Serialise outbound StockX calls. The official allotment allows ~1 req/sec, so
// we queue callers the same way priceCharting.ts serialises through _pcQueue.
let _sxQueue: Promise<void> = Promise.resolve();
const MIN_SPACING_MS = 1000;

async function sxFetch<T>(pathAndQuery: string): Promise<T> {
  const run = _sxQueue.then(async () => {
    const token = await getStockXToken();
    const res = await fetch(`${STOCKX_API_BASE}${pathAndQuery}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "x-api-key": stockxApiKey(),
        Accept: "application/json",
      },
    });
    await new Promise((r) => setTimeout(r, MIN_SPACING_MS));
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`StockX ${pathAndQuery} failed: HTTP ${res.status} ${body.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  });
  // Keep the queue chain alive even if this call rejects.
  _sxQueue = run.then(() => undefined, () => undefined);
  return run;
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

type StockXMarketData = {
  lowestAskAmount?: number | null;
  highestBidAmount?: number | null;
  flexLowestAskAmount?: number | null;
  sellFasterAmount?: number | null;
  earnMoreAmount?: number | null;
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
  const product = products[0];
  if (!product) {
    debugLines.push("No product match");
    return { ...empty, detectedSize };
  }

  const productUrl = product.urlKey ? `${STOCKX_PRODUCT_BASE}/${product.urlKey}` : null;
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
  const lowestAsk = market.lowestAskAmount ?? null;
  const highestBid = market.highestBidAmount ?? null;
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
