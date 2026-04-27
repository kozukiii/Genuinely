// Parses eBay listing fields into the inputs needed by sellerScore.
// listing.feedback = percentage string: "99.6", "99.6%", or "100.0% (2 ratings)"
// listing.score    = number of ratings (integer)
export function parseEbaySellerData(listing: any): { p: number | null; n: number | null } {
  let p: number | null = null;
  let n: number | null = null;

  const fb = listing.feedback;
  if (fb != null) {
    const str = String(fb).trim();
    const pctMatch = str.match(/^([\d.]+)/);
    if (pctMatch) {
      const val = parseFloat(pctMatch[1]);
      p = val > 1 ? val / 100 : val;
    }
    // Fallback: count embedded in string like "100.0% (2 ratings)"
    const countMatch = str.match(/\((\d+)\s*rating/i);
    if (countMatch) {
      n = parseInt(countMatch[1], 10);
    }
  }

  // listing.score is the dedicated ratings count field — takes precedence over embedded count
  if (listing.score != null && typeof listing.score === "number") {
    n = listing.score;
  }

  return { p, n };
}

export function calculateSellerTrust(p: number, n: number): number {
  const alpha = 10;
  const k = 25;
  const quality = Math.pow(p, alpha);
  const confidence = 1 - Math.exp(-n / k);
  let score = 100 * quality * confidence;

  if (n < 5) score = Math.min(score, 50);
  else if (n < 50) score = Math.min(score, 75);

  if (p < 0.85) score *= 0.60;
  else if (p < 0.90) score *= 0.75;

  return Math.round(score);
}
