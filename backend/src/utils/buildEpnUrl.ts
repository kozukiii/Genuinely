/**
 * Converts a plain eBay item URL into an eBay Partner Network (EPN) affiliate
 * tracking URL. All EPN parameters are appended as query-string entries.
 *
 * Safe to call with any input: malformed or empty values are returned unchanged.
 */

const EPN_PARAMS: Record<string, string> = {
  mkevt: "1",
  mkcid: "1",
  mkrid: "711-53200-19255-0",
  campid: process.env.EPN_CAMPAIGN_ID ?? "5339147277",
  toolid: "10001",
};

export function buildEpnUrl(url: string): string {
  if (!url) return url;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not a valid URL — return as-is rather than corrupting the link
    return url;
  }

  // Only transform eBay domains
  if (!parsed.hostname.endsWith("ebay.com") && !parsed.hostname.endsWith("ebay.co.uk")) {
    return url;
  }

  for (const [key, value] of Object.entries(EPN_PARAMS)) {
    parsed.searchParams.set(key, value);
  }

  return parsed.toString();
}
