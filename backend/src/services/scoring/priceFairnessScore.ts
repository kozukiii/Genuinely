/**
 * Deterministic price fairness scoring based on Tavily market context.
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

function isNewCondition(condition?: string, title?: string): boolean {
  const src = `${condition ?? ""} ${title ?? ""}`.toLowerCase();
  return (
    src.startsWith("new") ||
    /\bnew\s+(in\s+box|in\s+package|sealed|open\s+box|other)\b/.test(src) ||
    /\b(brand[- ]new|factory[- ]sealed|nos|nib)\b/.test(src)
  );
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

/**
 * Returns a 0–100 price fairness score, or null if context doesn't yield
 * a usable price range (caller should fall back to LLM score).
 */
export function calculatePriceFairness(
  price: number | null,
  context: string | null | undefined,
  condition?: string,
  title?: string,
): number | null {
  if (!context || price == null || price <= 0) return null;

  const range = extractPriceRange(context);
  if (!range) return null;

  const [lo, hi] = range;
  const span = hi - lo;
  const isNew = isNewCondition(condition, title);

  // Normalised position: 0 = at market low, 1 = at market high
  const pos = (price - lo) / span;

  let score: number;

  if (pos <= 0) {
    // At or below market low — excellent deal
    // Each 10% below low adds 1 bonus point, max bonus 5
    const bonus = Math.min(Math.abs(pos) * 10, 5);
    score = 95 + bonus;
  } else if (pos <= 1) {
    // Within range — linear 95 → 55
    score = 95 - pos * 40;
  } else {
    // Above market high
    // Each 10% above high adds 4 penalty points for new, 2 for used
    const overage = pos - 1;
    const penaltyRate = isNew ? 40 : 20;
    score = 55 - overage * penaltyRate;
  }

  // Non-new items: cap the downside at 10 points below neutral (75 → floor 65)
  if (!isNew && score < 65) {
    score = 65;
  }

  return Math.round(Math.max(0, Math.min(100, score)));
}
