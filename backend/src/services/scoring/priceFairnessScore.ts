/**
 * Deterministic price fairness scoring based on market context text.
 *
 * Rules:
 *  - Lower end of market range  → higher score (up to 100)
 *  - Midpoint of range          → ~75 (neutral)
 *  - Higher end of range        → penalty capped at 10 pts below neutral for non-new items
 *  - Higher end + NEW condition → full penalty applies (can score into 40s)
 *  - Price is 0, a known placeholder, or 10× above market → treated as "Accepts Offers"
 *  - No context / can't parse   → returns null (caller falls back to LLM score)
 */

/**
 * Known Facebook Marketplace placeholder prices sellers use when
 * they want offer-based pricing instead of a fixed price.
 */
const FB_PLACEHOLDER_PRICES = new Set([
  123456, 123456.00,
  1234567, 1234567.00,
  999999, 999999.00,
  9999999,
]);

/** Extract all dollar amounts from arbitrary text. */
function extractPrices(text: string): number[] {
  const matches = [...text.matchAll(/\$([0-9]{1,6}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)/g)];
  return matches
    .map((m) => parseFloat(m[1].replace(/,/g, "")))
    .filter((p) => Number.isFinite(p) && p > 0 && p < 500_000);
}

/**
 * Derive a [low, high] market range from context text.
 * Filters outliers so a graded/premium price mention doesn't skew the range
 * for a raw/ungraded listing.
 */
function extractPriceRange(context: string): [number, number] | null {
  const prices = extractPrices(context);
  if (prices.length < 2) return null;

  prices.sort((a, b) => a - b);

  // Remove extreme outliers: keep prices within 10× the median
  const mid = prices[Math.floor(prices.length / 2)];
  const filtered = prices.filter((p) => p >= mid / 10 && p <= mid * 10);

  if (filtered.length < 2) return null;

  // Use 15th and 85th percentile as the market low/high
  const lo = filtered[Math.floor(filtered.length * 0.15)];
  const hi = filtered[Math.ceil(filtered.length * 0.85) - 1] ?? filtered[filtered.length - 1];

  if (hi - lo < 0.01) return null; // degenerate range

  return [lo, hi];
}

/**
 * Returns true when a price should be treated as "Accepts Offers":
 *  - price is 0
 *  - price matches a known FB Marketplace placeholder
 *  - context is available and price is more than 10× the market high
 */
export function isAcceptsOffersPrice(
  price: number | null,
  context?: string | null,
): boolean {
  if (price === null) return false; // null = unavailable, not "Accepts Offers"
  if (price <= 0) return true;
  if (FB_PLACEHOLDER_PRICES.has(Math.round(price))) return true;

  // Context-based: if price is 10× above the market high it's clearly not a real ask
  if (context) {
    const range = extractPriceRange(context);
    if (range && price > range[1] * 10) return true;
  }

  return false;
}

function priceFairnessScore(price: number, low: number, high: number): number {
  if (price <= 0 || low <= 0 || high <= 0 || high <= low) return 50;

  const median = (low + high) / 2;
  const sweetSpotCeil = Math.min(low * 1.1, median);
  const medianScore = sweetSpotCeil >= median ? 100 : 90;

  if (price <= low * 0.5) return 0;

  if (price < low) return 100; // GREAT PRICE zone — below market low but not suspiciously cheap

  if (price <= sweetSpotCeil) return 100;

  if (sweetSpotCeil < median && price <= median) {
    const t = (price - sweetSpotCeil) / (median - sweetSpotCeil);
    return Math.round(100 - t * 10);
  }

  if (price <= high) {
    const t = (price - median) / (high - median);
    return Math.round(medianScore - t * (medianScore - 80));
  }

  const overpayRatio = (price - high) / high;
  return Math.max(0, Math.round(80 - Math.pow(overpayRatio, 0.5) * 100));
}

/**
 * Returns a 0–100 price fairness score, or null if no price range is available
 * (caller falls back to the LLM score for niche products without reliable data).
 */
export function calculatePriceFairness(
  price: number | null,
  context: string | null | undefined,
  priceLow?: number | null,
  priceHigh?: number | null,
): number | null {
  if (price == null || price <= 0) return null;

  // Prefer explicit low/high from context generation — same values shown in the chart
  const range: [number, number] | null =
    priceLow != null && priceHigh != null && priceHigh > priceLow
      ? [priceLow, priceHigh]
      : context ? extractPriceRange(context) : null;

  // No range → return null so caller uses LLM's guess (niche/unpriced products)
  if (!range) return null;

  return priceFairnessScore(price, range[0], range[1]);
}
