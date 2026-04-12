/**
 * Returns the ISO 3166-1 alpha-2 country code from the browser's preferred
 * language tag (e.g. "en-US" → "US", "fr-FR" → "FR").
 * Returns an empty string when the locale has no region subtag.
 */
export function getBrowserCountry(): string {
  try {
    const lang = navigator.language ?? "";
    const parts = lang.split("-");
    if (parts.length >= 2) {
      const cc = parts[parts.length - 1].toUpperCase();
      if (/^[A-Z]{2}$/.test(cc)) return cc;
    }
  } catch {}
  return "";
}
