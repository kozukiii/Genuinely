import type { Listing } from "../types/Listing";

const KEY = "recent:listings:v1";
const MAX = 12;

function safeParse<T>(value: string | null, fallback: T): T {
  try {
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function getRecentlyViewed(): Listing[] {
  return safeParse<Listing[]>(localStorage.getItem(KEY), []);
}

export function recordView(listing: Listing) {
  const current = getRecentlyViewed().filter((l) => l.id !== listing.id);
  const next = [listing, ...current].slice(0, MAX);
  localStorage.setItem(KEY, JSON.stringify(next));
}

export function updateRecentlyViewed(listing: Listing) {
  const current = getRecentlyViewed();
  if (!current.some((l) => l.id === listing.id)) return;
  localStorage.setItem(
    KEY,
    JSON.stringify(current.map((l) => (l.id === listing.id ? listing : l)))
  );
}
