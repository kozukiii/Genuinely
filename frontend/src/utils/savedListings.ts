import type { Listing } from "../types/Listing";

const KEY = "saved:listings:v1";

function safeParse<T>(value: string | null, fallback: T): T {
  try {
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function getSavedListings(): Listing[] {
  return safeParse<Listing[]>(localStorage.getItem(KEY), []);
}

export function setSavedListings(next: Listing[]) {
  localStorage.setItem(KEY, JSON.stringify(next));
  // notify the app so other components/pages can react
  window.dispatchEvent(new Event("saved:listings:changed"));
}

export function isSaved(id: string): boolean {
  return getSavedListings().some((x) => x.id === id);
}

export function toggleSaved(listing: Listing): boolean {
  const saved = getSavedListings();
  const exists = saved.some((x) => x.id === listing.id);

  const next = exists
    ? saved.filter((x) => x.id !== listing.id)
    : [listing, ...saved];

  setSavedListings(next);
  return !exists; // returns new state (true = saved)
}
