import type { Listing } from "../types/Listing";

const API_BASE  = import.meta.env.VITE_API_BASE_URL ?? "";
const LOCAL_KEY = "saved:listings:v1";

// ── Helpers ───────────────────────────────────────────────────────────────────

function safeParse<T>(value: string | null, fallback: T): T {
  try { return value ? (JSON.parse(value) as T) : fallback; }
  catch { return fallback; }
}

export function isLoggedIn(): boolean {
  // Populated by AuthContext after /auth/me resolves
  return _loggedIn;
}

let _loggedIn = false;
export function setLoggedIn(val: boolean) { _loggedIn = val; }

function notify() {
  window.dispatchEvent(new Event("saved:listings:changed"));
}

// ── Public API — all sync (localStorage is the local cache) ──────────────────

export function getSavedListings(): Listing[] {
  return safeParse<Listing[]>(localStorage.getItem(LOCAL_KEY), []);
}

export function setSavedListings(next: Listing[]) {
  localStorage.setItem(LOCAL_KEY, JSON.stringify(next));
  notify();
}

export function isSaved(id: string): boolean {
  return getSavedListings().some((x) => x.id === id);
}

export function updateSavedListing(listing: Listing) {
  const saved = getSavedListings();
  if (!saved.some((x) => x.id === listing.id)) return;
  setSavedListings(saved.map((x) => (x.id === listing.id ? listing : x)));

  if (isLoggedIn()) {
    fetch(`${API_BASE}/api/saved`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ listing }),
    }).catch(() => {});
  }
}

export function toggleSaved(listing: Listing): boolean {
  const saved  = getSavedListings();
  const exists = saved.some((x) => x.id === listing.id);
  const next   = exists
    ? saved.filter((x) => x.id !== listing.id)
    : [listing, ...saved];
  setSavedListings(next);

  if (isLoggedIn()) {
    if (exists) {
      const rollback = () => {
        const current = getSavedListings();
        if (!current.some((x) => x.id === listing.id)) {
          setSavedListings([...current, listing]);
        }
      };
      fetch(`${API_BASE}/api/saved/${listing.source}/${listing.id}`, {
        method: "DELETE", credentials: "include",
      }).then((res) => { if (!res.ok) rollback(); }).catch(rollback);
    } else {
      const rollback = () => {
        setSavedListings(getSavedListings().filter((x) => x.id !== listing.id));
      };
      fetch(`${API_BASE}/api/saved`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ listing }),
      }).then((res) => { if (!res.ok) rollback(); }).catch(rollback);
    }
  }

  return !exists;
}

// ── Called by AuthContext after login to merge local guest saves with server ──

export async function syncFromServer(): Promise<void> {
  try {
    const local = getSavedListings();

    // Push any local guest saves up to the server first
    for (const listing of local) {
      await fetch(`${API_BASE}/api/saved`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ listing }),
      }).catch(() => {});
    }

    // Then pull the full server list (now includes the merged items)
    const res = await fetch(`${API_BASE}/api/saved`, { credentials: "include" });
    if (!res.ok) return;
    const data = await res.json();
    const listings: Listing[] = data.listings ?? [];
    localStorage.setItem(LOCAL_KEY, JSON.stringify(listings));
    notify();
  } catch { /* silent */ }
}
