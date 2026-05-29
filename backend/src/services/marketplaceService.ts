import fetch from "node-fetch";
import type { Listing } from "../types/listing";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { HttpsProxyAgent } = require("https-proxy-agent");

const proxyUrls = process.env.PROXY_URL
  ? process.env.PROXY_URL.split(",").map((s) => s.trim()).filter(Boolean)
  : [];

const FETCH_TIMEOUT_MS = 12_000;   // utility calls (geocoding, etc.)
const FACEBOOK_TIMEOUT_MS = 4_000; // FB GraphQL / HTML — bail fast on tarpits
const RACE_STAGGER_MS = 800;       // gap between staggered race attempts
const FACEBOOK_BODY_TIMEOUT_MS = 4_000;
const PROXY_RACE_WIDTH = 6;
const STICKY_PROXY_POOL_SIZE = 3;
const STICKY_PROXY_TTL_MS = 10 * 60 * 1000;
const STICKY_RACE_STAGGER_MS = 350;
const POST_WIN_RACE_GRACE_MS = 1_500;

type StickyProxyEntry = {
  url: string;
  inflight: number;
  lastUsedAt: number;
  lastSucceededAt: number;
};

type ProxyTaggedResponse = Awaited<ReturnType<typeof fetch>> & {
  __proxyUrl?: string | null;
};

// Sticky proxy pool — empty means we're in racing mode.
// The race seeds up to three winners, then later requests spread over the pool.
let stickyProxyPool: StickyProxyEntry[] = [];

// Called by callers that detect a rate-limit signal in the response body.
export function markProxyRateLimited(proxyUrl?: string | null): void {
  if (proxyUrl) {
    const before = stickyProxyPool.length;
    stickyProxyPool = stickyProxyPool.filter((entry) => entry.url !== proxyUrl);
    if (before !== stickyProxyPool.length) {
      console.warn(`[proxy] rate limited on ${proxyUrl} — evicting from sticky pool`);
      return;
    }
    console.warn(`[proxy] rate limited on ${proxyUrl} — proxy was not in sticky pool`);
    return;
  }

  if (stickyProxyPool.length > 0) {
    console.warn("[proxy] rate limited without proxy attribution — clearing sticky pool");
  }
  stickyProxyPool = [];
}

function fetchWithTimeout(url: string, options: Parameters<typeof fetch>[1]): ReturnType<typeof fetch> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { ...options, signal: controller.signal as any }).finally(() => clearTimeout(timer));
}

function getResponseProxyUrl(res: Awaited<ReturnType<typeof fetch>> | null | undefined): string | null {
  const proxyUrl = (res as ProxyTaggedResponse | null | undefined)?.__proxyUrl;
  return typeof proxyUrl === "string" && proxyUrl.trim().length > 0 ? proxyUrl : null;
}

function hasMarketplaceRateLimitError(json: any): boolean {
  return Array.isArray(json?.errors) && json.errors.some((e: any) => e?.code === 1675004);
}

function pruneStickyProxyPool(now = Date.now()): void {
  stickyProxyPool = stickyProxyPool.filter((entry) => now - entry.lastSucceededAt < STICKY_PROXY_TTL_MS);
}

function addStickyProxyWinner(proxyUrl: string): void {
  const now = Date.now();
  pruneStickyProxyPool(now);

  const existing = stickyProxyPool.find((entry) => entry.url === proxyUrl);
  if (existing) {
    existing.lastSucceededAt = now;
    return;
  }

  if (stickyProxyPool.length >= STICKY_PROXY_POOL_SIZE) {
    return;
  }

  stickyProxyPool.push({
    url: proxyUrl,
    inflight: 0,
    lastUsedAt: 0,
    lastSucceededAt: now,
  });

  console.log(`[proxy] added ${proxyUrl} to sticky pool (${stickyProxyPool.length}/${STICKY_PROXY_POOL_SIZE})`);
}

function parseJsonWithTimeout<T>(
  res: Awaited<ReturnType<typeof fetch>>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutError = Object.assign(new Error(`${label} response body timed out`), {
      name: "AbortError",
      type: "aborted",
    });

    const timer = setTimeout(() => {
      const body = (res as any)?.body;
      if (body && typeof body.destroy === "function") {
        body.destroy(timeoutError);
      }
      reject(timeoutError);
    }, timeoutMs);

    res.json()
      .then((json) => {
        clearTimeout(timer);
        resolve(json as T);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function raceStickyProxyPool(
  url: string,
  options: Parameters<typeof fetch>[1],
  timeoutMs: number,
): ReturnType<typeof fetch> {
  pruneStickyProxyPool();

  const entries = stickyProxyPool
    .slice()
    .sort((a, b) => {
      if (a.inflight !== b.inflight) return a.inflight - b.inflight;
      return a.lastUsedAt - b.lastUsedAt;
    })
    .slice(0, STICKY_PROXY_POOL_SIZE);

  if (entries.length === 0) {
    return Promise.reject(new Error("Sticky proxy pool is empty"));
  }

  const outerController = new AbortController();
  const outerTimer = setTimeout(() => outerController.abort(), timeoutMs);
  const childControllers: AbortController[] = [];
  const staggerTimers: NodeJS.Timeout[] = [];
  let cleanupTimer: NodeJS.Timeout | null = null;

  return new Promise<Awaited<ReturnType<typeof fetch>>>((resolve, reject) => {
    let settled = false;
    let cleanedUp = false;
    let failures = 0;
    let winnerCtrl: AbortController | null = null;
    let lastError: unknown = null;

    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      clearTimeout(outerTimer);
      if (cleanupTimer) clearTimeout(cleanupTimer);
      for (const t of staggerTimers) clearTimeout(t);
      for (const ctrl of childControllers) {
        if (ctrl !== winnerCtrl) ctrl.abort();
      }
    };

    const finish = (
      winner: Awaited<ReturnType<typeof fetch>> | null,
      ctrl?: AbortController,
      err?: unknown,
    ) => {
      if (settled) return;
      settled = true;
      winnerCtrl = ctrl ?? null;
      if (winner) {
        clearTimeout(outerTimer);
        resolve(winner);
        cleanupTimer = setTimeout(() => cleanup(), POST_WIN_RACE_GRACE_MS);
      } else {
        cleanup();
        reject(err ?? new Error("Sticky proxy pool exhausted"));
      }
    };

    outerController.signal.addEventListener("abort", () =>
      finish(
        null,
        undefined,
        Object.assign(new Error("Marketplace fetch timed out"), { name: "AbortError", type: "aborted" })
      )
    );

    const tryEntry = (entry: StickyProxyEntry) => {
      if (cleanedUp || settled) return;

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      childControllers.push(ctrl);
      outerController.signal.addEventListener("abort", () => ctrl.abort());

      entry.inflight += 1;
      entry.lastUsedAt = Date.now();

      const reqOptions: any = { ...options, signal: ctrl.signal, agent: new HttpsProxyAgent(entry.url) };
      fetch(url, reqOptions)
        .then((res) => {
          clearTimeout(timer);
          entry.lastSucceededAt = Date.now();
          (res as ProxyTaggedResponse).__proxyUrl = entry.url;
          finish(res, ctrl);
        })
        .catch((err: any) => {
          clearTimeout(timer);
          stickyProxyPool = stickyProxyPool.filter((candidate) => candidate.url !== entry.url);
          console.warn(`[proxy] sticky proxy failed (${entry.url}: ${err?.message ?? "unknown error"}) — evicting`);
          lastError = err;
          failures += 1;
          if (!settled && failures === entries.length) {
            finish(null, undefined, lastError ?? err);
          }
        })
        .finally(() => {
          entry.inflight = Math.max(0, entry.inflight - 1);
        });
    };

    tryEntry(entries[0]);
    for (let i = 1; i < entries.length; i++) {
      staggerTimers.push(setTimeout(() => tryEntry(entries[i]), i * STICKY_RACE_STAGGER_MS));
    }
  });
}

function happyEyeballs(
  url: string,
  options: Parameters<typeof fetch>[1],
  timeoutMs: number,
): ReturnType<typeof fetch> {
  const urls: Array<string | null> =
    proxyUrls.length > 0
      ? [...proxyUrls].sort(() => Math.random() - 0.5).slice(0, PROXY_RACE_WIDTH)
      : [null];

  const outerController = new AbortController();
  const outerTimer = setTimeout(() => outerController.abort(), timeoutMs);
  const childControllers: AbortController[] = [];
  const staggerTimers: NodeJS.Timeout[] = [];
  let cleanupTimer: NodeJS.Timeout | null = null;

  return new Promise<Awaited<ReturnType<typeof fetch>>>((resolve, reject) => {
    let primarySettled = false;
    let cleanedUp = false;
    let failures = 0;
    let winners = 0;
    let primaryWinnerCtrl: AbortController | null = null;

    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      clearTimeout(outerTimer);
      if (cleanupTimer) clearTimeout(cleanupTimer);
      for (const t of staggerTimers) clearTimeout(t);
      for (const c of childControllers) {
        if (c !== primaryWinnerCtrl) c.abort();
      }
    };

    const finishPrimary = (
      winner: Awaited<ReturnType<typeof fetch>> | null,
      winnerCtrl?: AbortController,
      err?: unknown
    ) => {
      if (primarySettled) return;
      primarySettled = true;
      primaryWinnerCtrl = winnerCtrl ?? null;
      if (winner) {
        clearTimeout(outerTimer);
        resolve(winner);
        if (winners >= STICKY_PROXY_POOL_SIZE) {
          cleanup();
        } else {
          cleanupTimer = setTimeout(() => cleanup(), POST_WIN_RACE_GRACE_MS);
        }
      } else {
        cleanup();
        reject(err ?? new Error("All marketplace fetch attempts failed"));
      }
    };

    outerController.signal.addEventListener("abort", () =>
      finishPrimary(
        null,
        undefined,
        Object.assign(new Error("Marketplace fetch timed out"), { name: "AbortError", type: "aborted" })
      )
    );

    const tryUrl = (proxyUrl: string | null) => {
      if (cleanedUp) return;
      const ctrl = new AbortController();
      childControllers.push(ctrl);
      outerController.signal.addEventListener("abort", () => ctrl.abort());
      const reqOptions: any = { ...options, signal: ctrl.signal };
      if (proxyUrl) reqOptions.agent = new HttpsProxyAgent(proxyUrl);
      fetch(url, reqOptions)
        .then((res) => {
          (res as ProxyTaggedResponse).__proxyUrl = proxyUrl;
          if (proxyUrl) {
            addStickyProxyWinner(proxyUrl);
            winners += 1;
          }
          finishPrimary(res, ctrl);
          if (primarySettled && (winners >= STICKY_PROXY_POOL_SIZE || failures + winners >= urls.length)) {
            cleanup();
          }
        })
        .catch(() => {
          if (cleanedUp) return;
          failures += 1;
          if (!primarySettled && failures === urls.length) {
            finishPrimary(null);
            return;
          }
          if (primarySettled && failures + winners >= urls.length) {
            cleanup();
          }
        });
    };

    tryUrl(urls[0]);
    for (let i = 1; i < urls.length; i++) {
      staggerTimers.push(setTimeout(() => tryUrl(urls[i]), i * RACE_STAGGER_MS));
    }
  });
}

// Sticky-pool mode: prefer known-good proxies and only re-race when the pool is empty or exhausted.
// Failure or timeout evicts the bad proxy and falls back to the next pool member or a new race.
function raceProxiedFetch(
  url: string,
  options: Parameters<typeof fetch>[1],
  timeoutMs = FACEBOOK_TIMEOUT_MS,
): ReturnType<typeof fetch> {
  return (async () => {
    pruneStickyProxyPool();

    if (stickyProxyPool.length > 0) {
      try {
        return await raceStickyProxyPool(url, options, timeoutMs);
      } catch (err) {
        console.warn(
          `[proxy] sticky pool exhausted${err ? ` (${(err as any)?.message ?? "unknown error"})` : ""} — re-racing`
        );
      }
    }

    return happyEyeballs(url, options, timeoutMs);
  })();
}

const GRAPHQL_URL = "https://www.facebook.com/api/graphql/";
const FB_DESKTOP_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";


const latLngCache = new Map<string, { lat: number; lng: number; expiresAt: number }>();

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function geocodeCity(city: string, state: string): Promise<{ lat: number; lng: number } | null> {
  const key = `${city}, ${state}`.toLowerCase();
  const cached = latLngCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return { lat: cached.lat, lng: cached.lng };

  const url = `https://nominatim.openstreetmap.org/search?city=${encodeURIComponent(city)}&state=${encodeURIComponent(state)}&countrycodes=us&format=json&limit=1`;
  try {
    const res = await fetchWithTimeout(url, { headers: { "user-agent": "Genuinely/1.0" } });
    const json = await res.json() as Array<{ lat: string; lon: string }>;
    const first = json?.[0];
    if (!first) return null;
    const result = { lat: parseFloat(first.lat), lng: parseFloat(first.lon) };
    latLngCache.set(key, { lat: result.lat, lng: result.lng, expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
    return result;
  } catch {
    return null;
  }
}

async function getLatLng(zip: string) {
  const key = zip.trim();
  const cached = latLngCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return { lat: cached.lat, lng: cached.lng };

  const url = `https://nominatim.openstreetmap.org/search?postalcode=${encodeURIComponent(key)}&countrycodes=us&format=json&limit=1`;
  const res = await fetchWithTimeout(url, {
    headers: { "user-agent": "Genuinely/1.0" },
  });

  const json = await res.json() as Array<{ lat: string; lon: string; display_name: string }>;
  const first = json?.[0];
;
  const result = {
    lat: first ? parseFloat(first.lat) : undefined,
    lng: first ? parseFloat(first.lon) : undefined,
  };

  if (result.lat != null && result.lng != null) {
    latLngCache.set(key, { lat: result.lat, lng: result.lng, expiresAt: Date.now() + 60 * 60 * 1000 });
  }

  return result;
}

function normalizeMarketplaceImageUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;

  const trimmed = url.trim();
  if (!trimmed.startsWith("http")) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname.toLowerCase();

  if (!/(^|[.-])scontent[.-]|(^|[.-])fbsbx[.-]/.test(host)) return null;
  if (host.startsWith("static.") || pathname.includes("/rsrc.php")) return null;
  if (/\.(?:svg|wasm|gif)(?:$|[?#])/.test(pathname)) return null;
  if (/\/t1[._]/.test(trimmed)) return null;

  return trimmed;
}

function mergeMarketplaceImageArrays(...lists: unknown[]): string[] {
  const urls = new Set<string>();

  for (const list of lists) {
    if (!Array.isArray(list)) continue;

    for (const url of list) {
      const normalized = normalizeMarketplaceImageUrl(url);
      if (normalized) urls.add(normalized);
    }
  }

  return Array.from(urls);
}

function parseMarketplacePrice(...candidates: unknown[]): number | null {
  let sawExplicitZero = false;

  const parseCandidate = (candidate: unknown, depth = 0): number | null => {
    if (candidate == null || depth > 3) return null;

    if (typeof candidate === "number") {
      if (Number.isFinite(candidate) && candidate > 0) return candidate;
      if (candidate === 0) sawExplicitZero = true;
      return null;
    }

    if (typeof candidate === "string") {
      const trimmed = candidate.trim();
      if (!trimmed) return null;

      if (/accepts?\s+offers?/i.test(trimmed)) {
        sawExplicitZero = true;
        return null;
      }

      const stripped = trimmed.replace(/,/g, "").match(/[0-9]+(?:\.[0-9]+)?/)?.[0] ?? "";
      if (stripped === "0") {
        sawExplicitZero = true;
        return null;
      }

      const parsed = Number(stripped);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    }

    if (typeof candidate !== "object") return null;

    const objectCandidate = candidate as Record<string, unknown>;
    const offsetAmount = Number(objectCandidate.amount);
    const offset = Number(objectCandidate.offset);
    if (Number.isFinite(offsetAmount) && offsetAmount > 0 && Number.isFinite(offset) && offset > 1) {
      return offsetAmount / offset;
    }

    const nestedCandidates = [
      objectCandidate.amount,
      objectCandidate.formatted_amount,
      objectCandidate.formattedAmount,
      objectCandidate.text,
      objectCandidate.price,
      objectCandidate.listing_price,
      objectCandidate.formatted_price,
      objectCandidate.amount_with_offset,
      objectCandidate.amountWithOffset,
    ];

    for (const nested of nestedCandidates) {
      const parsed = parseCandidate(nested, depth + 1);
      if (parsed !== null) return parsed;
    }

    return null;
  };

  for (const candidate of candidates) {
    const parsed = parseCandidate(candidate);
    if (parsed !== null) return parsed;
  }

  return sawExplicitZero ? 0 : null;
}

function extractMarketplacePrice(source: any): number | null {
  return parseMarketplacePrice(
    source?.listing_price,
    source?.listing_price?.amount,
    source?.listing_price?.formatted_amount,
    source?.formatted_price,
    source?.formatted_price?.text,
    source?.price,
    source?.price?.text,
    source?.marketplace_listing_price,
    source?.marketplace_listing_renderable_target?.listing_price,
    source?.marketplace_listing_renderable_target?.formatted_price,
    source?.product_item?.listing_price,
    source?.product_item?.formatted_price,
  );
}

async function searchMarketplaceListingsByLatLng({
  query,
  lat,
  lng,
  limit = 10,
  radiusKm = 16,
  enrichImages = true,
}: {
  query: string;
  lat: number;
  lng: number;
  limit?: number;
  radiusKm?: number;
  enrichImages?: boolean;
}) {
  const variables = {
    count: limit,
    params: {
      bqf: {
        callsite: "COMMERCE_MKTPLACE_WWW",
        query,
      },
      browse_request_params: {
        filter_location_latitude: lat,
        filter_location_longitude: lng,
        filter_radius_km: radiusKm,
      },
      custom_request_params: {
        surface: "SEARCH",
      },
    },
  };

  const body = new URLSearchParams({
    variables: JSON.stringify(variables),
    doc_id: "7111939778879383",
  });

  const res = await raceProxiedFetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      "user-agent": "Mozilla/5.0",
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const json = await parseJsonWithTimeout<any>(res, FACEBOOK_BODY_TIMEOUT_MS, "Marketplace browse API");
  if (hasMarketplaceRateLimitError(json)) {
    markProxyRateLimited(getResponseProxyUrl(res));
    throw new Error("Marketplace rate limit exceeded");
  }
  const edges = json?.data?.marketplace_search?.feed_units?.edges ?? [];

  const listings = edges.map((edge: any) => {
    const listing = edge?.node?.listing;
    const images = buildMarketplaceImageGallery([
      edge?.node,
      listing,
      listing?.product_item,
      listing?.marketplace_listing_renderable_target,
    ]);

    return {
      id: String(listing?.id ?? ""),
      source: "marketplace",
      title: listing?.marketplace_listing_title ?? "Untitled listing",
      price: extractMarketplacePrice(listing) ?? extractMarketplacePrice(edge?.node),
      currency: "USD",
      url: listing?.id
        ? `https://www.facebook.com/marketplace/item/${listing.id}`
        : "",
      images,
      location: [
        listing?.location?.reverse_geocode?.city,
        listing?.location?.reverse_geocode?.state,
      ]
        .filter(Boolean)
        .join(", "),
      is_live: listing?.is_live ?? false,
      is_pending: listing?.is_pending ?? false,
      is_sold: listing?.is_sold ?? false,
      delivery_types: Array.isArray(listing?.delivery_types)
        ? listing.delivery_types
        : [],
      raw: listing,
    };
  });

  // Pre-geocode unique city/state combos in parallel (results cached 24h)
  const cityKeys = new Map<string, { lat: number; lng: number } | null>();
  for (const l of listings) {
    const city = l.raw?.location?.reverse_geocode?.city;
    const state = l.raw?.location?.reverse_geocode?.state;
    if (city && state) cityKeys.set(`${city}|${state}`, null);
  }
  await Promise.all(
    [...cityKeys.keys()].map(async (key) => {
      const [city, state] = key.split("|");
      cityKeys.set(key, await geocodeCity(city, state));
    })
  );

  const filtered = listings.filter((l: any) => {
    const listingLat = Number(l.raw?.location?.latitude);
    const listingLng = Number(l.raw?.location?.longitude);
    if (Number.isFinite(listingLat) && Number.isFinite(listingLng)) {
      return haversineKm(lat, lng, listingLat, listingLng) <= radiusKm;
    }
    const city = l.raw?.location?.reverse_geocode?.city;
    const state = l.raw?.location?.reverse_geocode?.state;
    if (!city || !state) return true;
    const coords = cityKeys.get(`${city}|${state}`);
    if (!coords) return true;
    return haversineKm(lat, lng, coords.lat, coords.lng) <= radiusKm;
  });

  if (!enrichImages || filtered.length === 0) {
    return filtered;
  }

  return enrichMarketplaceSearchListings(filtered);
}

function extractMarketplaceImages(listing: any): string[] {
  const urls = new Set<string>();

  const pushIfValid = (url: unknown) => {
    const normalized = normalizeMarketplaceImageUrl(url);
    if (normalized) urls.add(normalized);
  };

  const pushImageCandidate = (candidate: any) => {
    if (!candidate) return;

    pushIfValid(candidate);
    pushIfValid(candidate?.image?.uri);
    pushIfValid(candidate?.image?.url);
    pushIfValid(candidate?.uri);
    pushIfValid(candidate?.url);
    pushIfValid(candidate?.photo?.image?.uri);
    pushIfValid(candidate?.listing_photo?.image?.uri);
    pushIfValid(candidate?.node?.image?.uri);
    pushIfValid(candidate?.node?.uri);
    pushIfValid(candidate?.node?.url);
  };

  const pushDeepFacebookImages = (value: unknown, depth = 0) => {
    if (!value || depth > 8) return;

    if (typeof value === "string") {
      if (/(?:scontent|fbcdn|fbsbx)/i.test(value)) {
        pushIfValid(value);
      }
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        pushDeepFacebookImages(item, depth + 1);
      }
      return;
    }

    if (typeof value !== "object") return;

    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (/feedback|comment|reaction|actor|profile|avatar/i.test(key)) continue;
      pushDeepFacebookImages(child, depth + 1);
    }
  };

  // Primary listing photo
  pushIfValid(listing?.primary_listing_photo?.image?.uri);
  pushIfValid(listing?.primary_photo?.image?.uri);

  const possibleArrays = [
    listing?.listing_photos,
    listing?.photos,
    listing?.all_photos,
    listing?.additional_photos,
    listing?.media,
    listing?.images,
    listing?.photo_images,
    listing?.media_set?.edges,
    listing?.photo_groups?.edges,
  ];

  for (const arr of possibleArrays) {
    if (!Array.isArray(arr)) continue;

    for (const item of arr) {
      pushImageCandidate(item);
    }
  }

  // Facebook Relay field names drift often; the PDP media query can expose
  // gallery photos under nested image/uri/url paths that are not listed above.
  pushDeepFacebookImages(listing);

  return Array.from(urls);
}

function buildMarketplaceImageGallery(sources: any[]): string[] {
  const imageSet = new Set<string>();

  for (const source of sources) {
    for (const url of extractMarketplaceImages(source)) {
      imageSet.add(url);
    }
  }

  return Array.from(imageSet);
}



function extractMarketplaceDescription(target: any): string | undefined {
  const candidates = [
    target?.redacted_description?.text,
    target?.description?.text,
    target?.story?.message?.text,
    target?.story?.translated_message_for_viewer?.text,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  return undefined;
}

function formatMarketplaceLocation(target: any): string | undefined {
  const displayName = target?.location?.reverse_geocode?.city_page?.display_name;
  if (typeof displayName === "string" && displayName.trim()) return displayName.trim();

  const locationText = target?.location_text?.text;
  if (typeof locationText === "string" && locationText.trim()) return locationText.trim();

  const parts = [
    target?.location?.reverse_geocode?.city,
    target?.location?.reverse_geocode?.state,
  ]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .map((part) => part.trim());

  return parts.length ? parts.join(", ") : undefined;
}


function extractMarketplaceCoordinates(source: any): { lat: number; lng: number } | null {
  const candidates = [
    source?.location,
    source?.marketplace_listing_renderable_target?.location,
    source?.raw?.location,
  ];

  for (const candidate of candidates) {
    const lat = Number(candidate?.latitude);
    const lng = Number(candidate?.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      return { lat, lng };
    }
  }

  return null;
}

function attachSearchMetadataToMarketplaceListing(detailListing: Listing, searchMatch: any): Listing {
  const mergedRaw =
    detailListing.raw && typeof detailListing.raw === "object" && searchMatch?.raw && typeof searchMatch.raw === "object"
      ? { ...(searchMatch.raw as Record<string, unknown>), ...(detailListing.raw as Record<string, unknown>) }
      : detailListing.raw ?? searchMatch?.raw;
  const detailPrice = detailListing.price;
  const searchPrice = searchMatch?.price;
  const price =
    typeof detailPrice === "number" && detailPrice > 0
      ? detailPrice
      : typeof searchPrice === "number" && searchPrice > 0
        ? searchPrice
        : detailPrice ?? searchPrice ?? null;

  return {
    ...searchMatch,
    ...detailListing,
    price,
    images: mergeMarketplaceImageArrays(detailListing.images, searchMatch?.images),
    raw: mergedRaw,
  } as Listing;
}

function buildMarketplaceListingFromProductDetails(
  listingId: string,
  detailsPage: any,
  mediaPage: any | null
): Listing {
  const target = detailsPage?.target;
  const images = buildMarketplaceImageGallery([
    mediaPage?.target,
    target,
    target?.product_item,
    detailsPage?.marketplace_listing_renderable_target,
  ]);

  const description = extractMarketplaceDescription(target);
  const location = formatMarketplaceLocation(target);
  const seller =
    target?.marketplace_listing_seller?.name ??
    target?.seller?.name ??
    target?.story?.actors?.[0]?.name;
  const url =
    (typeof target?.share_uri === "string" && target.share_uri.trim()) ||
    `https://www.facebook.com/marketplace/item/${listingId}`;

  return {
    id: listingId,
    source: "marketplace",
    title: target?.marketplace_listing_title ?? "Marketplace Listing",
    price: extractMarketplacePrice(target),
    currency: target?.listing_price?.currency ?? "USD",
    url,
    link: url,
    images,
    seller: typeof seller === "string" && seller.trim() ? seller.trim() : undefined,
    condition:
      typeof target?.condition === "string" && target.condition.trim()
        ? target.condition.trim()
        : undefined,
    location,
    itemLocation: location,
    description,
    fullDescription: description,
    raw: target,
  };
}

const MARKETPLACE_PDP_CONTAINER_DOC_ID = "26924013917190310";

const MARKETPLACE_PDP_RELAY_PROVIDERS = {
  "__relay_internal__pv__ShouldUpdateMarketplaceBoostListingBoostedStatusrelayprovider": false,
  "__relay_internal__pv__CometUFISingleLineUFIrelayprovider": false,
  "__relay_internal__pv__CometUFIShareActionMigrationrelayprovider": true,
  "__relay_internal__pv__CometUFIReactionsEnableShortNamerelayprovider": false,
  "__relay_internal__pv__CometUFICommentAutoTranslationTyperelayprovider": "ORIGINAL",
  "__relay_internal__pv__CometUFICommentAvatarStickerAnimatedImagerelayprovider": false,
  "__relay_internal__pv__CometUFICommentActionLinksRewriteEnabledrelayprovider": false,
  "__relay_internal__pv__IsWorkUserrelayprovider": false,
  "__relay_internal__pv__GHLShouldChangeSponsoredDataFieldNamerelayprovider": false,
  "__relay_internal__pv__GHLShouldChangeAdIdFieldNamerelayprovider": false,
  "__relay_internal__pv__CometUFI_dedicated_comment_routable_dialog_gkrelayprovider": true,
};

const MARKETPLACE_PDP_MEDIA_DOC_ID = "10059604367394414";

function makeGraphqlRequest(
  listingId: string,
  docId: string,
  friendlyName: string,
  variables: Record<string, unknown>,
) {
  const body = new URLSearchParams({
    variables: JSON.stringify(variables),
    doc_id: docId,
    server_timestamps: "true",
    fb_api_caller_class: "RelayModern",
    fb_api_req_friendly_name: friendlyName,
  });

  return raceProxiedFetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      "user-agent": FB_DESKTOP_USER_AGENT,
      "content-type": "application/x-www-form-urlencoded",
      "accept": "*/*",
      "accept-language": "en-US,en;q=0.9",
      "x-fb-friendly-name": friendlyName,
      "referer": `https://www.facebook.com/marketplace/item/${listingId}/`,
      "origin": "https://www.facebook.com",
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
    },
    body,
  });
}

async function fetchMarketplaceListingByContainerQuery(listingId: string): Promise<{ details: any; media: any } | null> {
  const containerVars = {
    targetId: listingId,
    feedLocation: "MARKETPLACE_MEGAMALL",
    feedbackSource: 56,
    scale: 1,
    useDefaultActor: false,
    enableJobEmployerActionBar: false,
    enableJobSeekerActionBar: false,
    referralCode: null,
    referralSurfaceString: null,
    ...MARKETPLACE_PDP_RELAY_PROVIDERS,
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const [containerRes, mediaRes] = await Promise.all([
        makeGraphqlRequest(listingId, MARKETPLACE_PDP_CONTAINER_DOC_ID, "MarketplacePDPContainerQuery", containerVars),
        makeGraphqlRequest(listingId, MARKETPLACE_PDP_MEDIA_DOC_ID, "MarketplacePDPC2CMediaViewerWithImagesQuery", { targetId: listingId }),
      ]);

      if (containerRes.status !== 200) {
        console.warn(`[marketplace:containerQuery] HTTP ${containerRes.status} for listing ${listingId}`);
        if (attempt < 1) continue;
        return null;
      }

      const containerJson = await parseJsonWithTimeout<any>(
        containerRes,
        FACEBOOK_BODY_TIMEOUT_MS,
        `Marketplace container query ${listingId}`
      );
      if (hasMarketplaceRateLimitError(containerJson)) {
        markProxyRateLimited(getResponseProxyUrl(containerRes));
        throw new Error("Marketplace rate limit exceeded");
      }
      const details = containerJson?.data?.viewer?.marketplace_product_details_page ?? null;

      if (!details?.target?.marketplace_listing_title) {
        console.warn(`[marketplace:containerQuery] No listing data in response for ${listingId}`);
        if (attempt < 1) continue;
        return null;
      }

      let media: any = null;
      if (mediaRes.status === 200) {
        const mediaJson = await parseJsonWithTimeout<any>(
          mediaRes,
          FACEBOOK_BODY_TIMEOUT_MS,
          `Marketplace media query ${listingId}`
        );
        if (hasMarketplaceRateLimitError(mediaJson)) {
          markProxyRateLimited(getResponseProxyUrl(mediaRes));
          throw new Error("Marketplace rate limit exceeded");
        }
        media = mediaJson?.data?.viewer?.marketplace_product_details_page ?? null;
      } else {
        console.warn(`[marketplace:mediaQuery] HTTP ${mediaRes.status} for listing ${listingId}`);
      }

      return { details, media };
    } catch (err: any) {
      console.warn(`[marketplace:containerQuery] Failed for ${listingId} (attempt ${attempt + 1}):`, err);
      if (attempt < 1 && err?.type !== "aborted") continue;
      return null;
    }
  }
  return null;
}

export async function getMarketplaceListingByGraphqlForAnalysis(listingId: string): Promise<Listing> {
  const result = await fetchMarketplaceListingByContainerQuery(listingId);

  if (!result) {
    throw new Error("Marketplace listing unavailable or could not be retrieved.");
  }

  return { ...buildMarketplaceListingFromProductDetails(listingId, result.details, result.media), _pdpFetched: true } as any;
}

export async function getMarketplaceListingBySearchForAnalysis(listingId: string): Promise<Listing> {
  const seedListing = await getMarketplaceListingByGraphqlForAnalysis(listingId);
  const title = typeof seedListing.title === "string" ? seedListing.title.trim() : "";

  if (!title) return seedListing;

  const exactMatchFromResults = async (resultsPromise: Promise<any[]>) => {
    try {
      const results = await resultsPromise;
      return results.find((result) => String(result?.id ?? "") === listingId) ?? null;
    } catch (err) {
      console.warn("Marketplace link-analysis search fallback failed:", err);
      return null;
    }
  };

  const coords = extractMarketplaceCoordinates(seedListing.raw);
  const locationText = seedListing.location ?? seedListing.itemLocation ?? null;

  const exactMatch =
    (coords
      ? await exactMatchFromResults(
          searchMarketplaceListingsByLatLng({
            query: title,
            lat: coords.lat,
            lng: coords.lng,
            limit: 24,
            enrichImages: false,
          })
        )
      : null) ??
    (locationText
      ? await exactMatchFromResults(
          searchMarketplaceListings({
            query: title,
            location: locationText,
            limit: 24,
            enrichImages: false,
          })
        )
      : null);

  if (!exactMatch) {
    return seedListing;
  }

  return attachSearchMetadataToMarketplaceListing(seedListing, exactMatch);
}

const MARKETPLACE_SEARCH_IMAGE_ENRICHMENT_CONCURRENCY = 6;

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      if (currentIndex >= items.length) return;

      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  });

  await Promise.all(workers);
  return results;
}

async function enrichMarketplaceSearchListings(listings: Listing[]): Promise<Listing[]> {
  return mapWithConcurrency(
    listings,
    MARKETPLACE_SEARCH_IMAGE_ENRICHMENT_CONCURRENCY,
    async (listing) => {
      if (!listing.id) return listing;

      try {
        const detailListing = await getMarketplaceListingByGraphqlForAnalysis(listing.id);
        return attachSearchMetadataToMarketplaceListing(detailListing, listing);
      } catch (err) {
        console.warn(`[marketplace:searchImages] Failed to enrich ${listing.id}:`, err);
        return listing;
      }
    }
  );
}

export async function getMarketplaceListing(listingId: string): Promise<Partial<Listing>> {
  try {
    const listing = await getMarketplaceListingByGraphqlForAnalysis(listingId);
    return {
      images: listing.images,
      description: listing.description,
      fullDescription: listing.fullDescription,
    };
  } catch (err) {
    console.error("getMarketplaceListing error:", err);
    return {};
  }
}

export async function getMarketplaceListingFull(listingId: string): Promise<Listing> {
  return getMarketplaceListingByGraphqlForAnalysis(listingId);
}

export async function searchMarketplaceListings({
  query,
  location,
  lat,
  lng,
  limit = 10,
  radiusKm,
  enrichImages = true,
}: {
  query: string;
  location?: string;
  lat?: number;
  lng?: number;
  limit?: number;
  radiusKm?: number;
  enrichImages?: boolean;
}) {
  const hasCoords = Number.isFinite(lat) && Number.isFinite(lng);

  if (hasCoords) {
    return searchMarketplaceListingsByLatLng({
      query,
      lat: lat as number,
      lng: lng as number,
      limit,
      radiusKm,
      enrichImages,
    });
  }

  const locationText = typeof location === "string" ? location.trim() : "";
  if (!locationText) {
    throw new Error("Location lookup failed");
  }

  const resolved = await getLatLng(locationText);

  if (resolved.lat == null || resolved.lng == null) {
    throw new Error("Location lookup failed");
  }

  return searchMarketplaceListingsByLatLng({
    query,
    lat: resolved.lat,
    lng: resolved.lng,
    limit,
    radiusKm,
    enrichImages,
  });
}

export const searchMarketplaceNormalized = searchMarketplaceListings;
