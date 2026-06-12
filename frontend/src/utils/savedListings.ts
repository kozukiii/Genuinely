import type { Listing } from "../types/Listing";

const API_BASE  = import.meta.env.VITE_API_BASE_URL ?? "";
const LOCAL_KEY = "saved:listings:v1";
const SESSION_HEALTH_CHECK_KEY = "saved:listings:health-check:last-run";
const HEALTH_CHECK_LIMIT = 12;
const ACTIVE_HEALTH_TTL_MS = 60 * 60 * 1000;
const UNKNOWN_HEALTH_TTL_MS = 30 * 60 * 1000;
const INACTIVE_HEALTH_TTL_MS = 6 * 60 * 60 * 1000;
const SESSION_HEALTH_CHECK_INTERVAL_MS = 60 * 60 * 1000;

let healthInFlight = false;

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

function listingKey(listing: Pick<Listing, "source" | "id">): string {
  return `${listing.source}:${listing.id}`;
}

function isInactiveStatus(status: Listing["availabilityStatus"]): boolean {
  return status === "sold" || status === "ended" || status === "removed";
}

function needsHealthCheck(listing: Listing): boolean {
  if (!listing.id || !listing.source) return false;

  const checkedAt = listing.availabilityCheckedAt ? Date.parse(listing.availabilityCheckedAt) : NaN;
  if (!Number.isFinite(checkedAt)) return true;

  const ttl = isInactiveStatus(listing.availabilityStatus)
    ? INACTIVE_HEALTH_TTL_MS
    : listing.availabilityStatus === "unknown"
      ? UNKNOWN_HEALTH_TTL_MS
      : ACTIVE_HEALTH_TTL_MS;

  return Date.now() - checkedAt > ttl;
}

function mergeHealthResults(current: Listing[], checked: Listing[]): { next: Listing[]; changed: Listing[] } {
  const patches = new Map(checked.map((listing) => [listingKey(listing), listing]));
  const changed: Listing[] = [];

  const next = current.map((listing) => {
    const patch = patches.get(listingKey(listing));
    if (!patch) return listing;

    const merged = { ...listing, ...patch };
    const didChange =
      listing.availabilityStatus !== merged.availabilityStatus
      || listing.availabilityCheckedAt !== merged.availabilityCheckedAt
      || listing.availabilityReason !== merged.availabilityReason
      || listing.endedAt !== merged.endedAt
      || listing.lastSeenActiveAt !== merged.lastSeenActiveAt;

    if (didChange) changed.push(merged);
    return merged;
  });

  return { next, changed };
}

function readLastSessionHealthCheckAt(): number | null {
  const raw = sessionStorage.getItem(SESSION_HEALTH_CHECK_KEY);
  if (!raw) return null;

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function markSessionHealthCheck(now: number) {
  sessionStorage.setItem(SESSION_HEALTH_CHECK_KEY, String(now));
}

function shouldRunSessionHealthCheck(now: number): boolean {
  const lastRunAt = readLastSessionHealthCheckAt();
  return lastRunAt == null || now - lastRunAt >= SESSION_HEALTH_CHECK_INTERVAL_MS;
}

export async function refreshSavedListingsHealthCheck(
  listings = getSavedListings(),
  options: { force?: boolean } = {},
): Promise<Listing[]> {
  if (healthInFlight || listings.length === 0) return listings;
  const now = Date.now();

  if (!options.force && !shouldRunSessionHealthCheck(now)) return listings;

  const targets = (options.force ? listings : listings.filter(needsHealthCheck)).slice(0, HEALTH_CHECK_LIMIT);
  if (targets.length === 0) return listings;

  healthInFlight = true;
  try {
    const res = await fetch(`${API_BASE}/api/search/health`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ listings: targets, force: options.force === true }),
    });
    if (!res.ok) return listings;

    const data = await res.json();
    const checked: Listing[] = Array.isArray(data.listings) ? data.listings : [];
    markSessionHealthCheck(now);
    if (checked.length === 0) return listings;

    const current = safeParse<Listing[]>(localStorage.getItem(LOCAL_KEY), []);
    const { next, changed } = mergeHealthResults(current, checked);
    if (changed.length === 0) return current;

    setSavedListings(next);

    if (isLoggedIn()) {
      changed.forEach((listing) => {
        fetch(`${API_BASE}/api/saved`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ listing }),
        }).catch(() => {});
      });
    }

    return next;
  } catch {
    // Health checks are best-effort; stale saved data should never block the UI.
    return listings;
  } finally {
    healthInFlight = false;
  }
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

// Re-fetch live source content for saved stubs that lack it. Returns a map keyed
// by `source:id`. Best-effort: removed/unavailable listings are simply omitted.
async function hydrateListings(stubs: Listing[]): Promise<Map<string, Listing>> {
  const out = new Map<string, Listing>();
  if (stubs.length === 0) return out;

  try {
    const res = await fetch(`${API_BASE}/api/saved/hydrate`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: stubs.map((l) => ({ source: l.source, id: l.id })) }),
    });
    if (!res.ok) return out;

    const data = await res.json();
    const listings: Listing[] = Array.isArray(data.listings) ? data.listings : [];
    for (const listing of listings) out.set(listingKey(listing), listing);
  } catch { /* hydration is best-effort */ }

  return out;
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

    // Then pull the server list. These are analysis-only stubs (scores + identity);
    // the source's content (title/images/price) is never stored server-side.
    const res = await fetch(`${API_BASE}/api/saved`, { credentials: "include" });
    if (!res.ok) return;
    const data = await res.json();
    const stubs: Listing[] = data.listings ?? [];

    // Merge any content we already have cached locally on top of the stub identity,
    // keeping the server's freshly-synced analysis fields.
    const localByKey = new Map(local.map((l) => [listingKey(l), l]));
    const merged: Listing[] = stubs.map((stub) => {
      const cached = localByKey.get(listingKey(stub));
      return cached ? { ...cached, ...stub } : stub;
    });

    // Stubs with no locally-cached content (e.g. fresh device) need live content
    // re-fetched from the source so the card can render.
    const needHydration = merged.filter((l) => !l.title || !Array.isArray(l.images) || l.images.length === 0);
    const hydrated = await hydrateListings(needHydration);
    if (hydrated.size > 0) {
      for (let i = 0; i < merged.length; i++) {
        const content = hydrated.get(listingKey(merged[i]));
        // Live content first, then re-apply the analysis stub so scores always win.
        if (content) merged[i] = { ...content, ...merged[i] };
      }
    }

    localStorage.setItem(LOCAL_KEY, JSON.stringify(merged));
    notify();
  } catch { /* silent */ }
}
