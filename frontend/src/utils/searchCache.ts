import type { Listing } from "../types/Listing";

const KEY = "genuinely:search_cache";
const CAP = 150;

export function addToSearchCache(listings: Listing[]): void {
  const scored = listings.filter((l) => l.aiScore != null);
  if (scored.length === 0) return;

  try {
    const existing = getSearchCache();
    const seenKeys = new Set(existing.map((l) => `${l.source}:${l.id}`));

    const incoming = scored.filter((l) => !seenKeys.has(`${l.source}:${l.id}`));
    if (incoming.length === 0) return;

    // Newest at the front, trim to cap
    const merged = [...incoming, ...existing].slice(0, CAP);
    localStorage.setItem(KEY, JSON.stringify(merged));
  } catch {
    // localStorage quota exceeded or unavailable — silently skip
  }
}

export function getSearchCache(): Listing[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
