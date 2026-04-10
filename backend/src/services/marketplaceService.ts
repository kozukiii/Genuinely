import fetch from "node-fetch";
import type { Listing } from "../types/listing";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { HttpsProxyAgent } = require("https-proxy-agent");

const proxyUrls = process.env.PROXY_URL
  ? process.env.PROXY_URL.split(",").map((s) => s.trim()).filter(Boolean)
  : [];

const FETCH_TIMEOUT_MS = 12_000;

function getProxyAgent() {
  if (proxyUrls.length === 0) return undefined;
  const url = proxyUrls[Math.floor(Math.random() * proxyUrls.length)];
  return new HttpsProxyAgent(url);
}

function fetchWithTimeout(url: string, options: Parameters<typeof fetch>[1]): ReturnType<typeof fetch> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { ...options, signal: controller.signal as any }).finally(() => clearTimeout(timer));
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

  const res = await fetchWithTimeout(GRAPHQL_URL, {
    method: "POST",
    headers: {
      "user-agent": "Mozilla/5.0",
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
    ...(proxyUrls.length ? { agent: getProxyAgent() } : {}),
  });

  const json = await res.json();
  if (json?.errors?.some((e: any) => e.code === 1675004)) {
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
      price: Number(
        String(listing?.listing_price?.formatted_amount ?? "0").replace(
          /[^0-9.]/g,
          ""
        ) || 0
      ),
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

function extractImagesFromHtml(html: string, _listingId: string): string[] {
  const byFilename = new Map<string, string>();
  const addUri = (raw: string) => {
    const url = raw.replace(/\\u0025/g, "%").replace(/\\\//g, "/").replace(/&amp;/g, "&");
    if (!url.startsWith("http")) return;
    if (!url.includes("scontent")) return;
    if (/\/t1[._]/.test(url)) return; // profile pictures, not listing photos
    const fnMatch = url.match(/\/(\d+_[^/?#"\\]+\.(?:jpg|jpeg|png|webp))/i);
    const key = fnMatch ? fnMatch[1] : url;
    if (!byFilename.has(key)) byFilename.set(key, url);
  };

  // Listing photos are in 178px-tall containers; "Today's picks" thumbnails are 174px.
  // Checking the 80 chars before each <img> reliably separates them.
  const imgPattern = /<img[^>]+src="(https?:\/\/[^"]*scontent[^"]*)"/gi;
  let m;
  while ((m = imgPattern.exec(html)) !== null) {
    const before = html.slice(Math.max(0, m.index - 80), m.index);
    if (before.includes("height:174px")) continue; // related listing thumbnail
    addUri(m[1]);
  }

  // og:image gives the highest-quality primary — always first
  const ogMatch = html.match(/<meta[^>]+property="og:image"\s+content="(https:\/\/[^"]*scontent[^"]*)"/);
  const primary = ogMatch ? ogMatch[1].replace(/&amp;/g, "&") : undefined;

  const results = Array.from(byFilename.values());

  if (primary) {
    const base = primary.split("?")[0];
    return [primary, ...results.filter(u => !u.startsWith(base))];
  }
  return results;
}

function extractTitleFromHtml(html: string): string | undefined {
  const og = html.match(/<meta[^>]+property="og:title"\s+content="([^"]+)"/);
  if (og) return og[1].replace(/&amp;/g, "&").replace(/&#039;/g, "'").trim();
  const m = html.match(/"marketplace_listing_title"\s*:\s*"([^"]+)"/);
  if (m) return m[1];
  const h1 = html.match(/<h1[^>]*>([^<]+)<\/h1>/);
  if (h1) return h1[1].trim();
  return undefined;
}

function extractPriceFromHtml(html: string): number {
  const m = html.match(/"formatted_amount"\s*:\s*"([^"]+)"/);
  if (m) {
    const n = Number(m[1].replace(/[^0-9.]/g, ""));
    if (!isNaN(n) && n > 0) return n;
  }
  const dollar = html.match(/\$\s*([0-9][0-9,]*(?:\.[0-9]{2})?)/);
  if (dollar) {
    const n = Number(dollar[1].replace(/,/g, ""));
    if (!isNaN(n) && n > 0) return n;
  }
  return 0;
}

function extractDescriptionFromHtml(html: string): string | undefined {
  // Embedded Relay JSON blobs — same format on www, m, and mbasic
  const m = html.match(/"redacted_description"\s*:\s*\{\s*"text"\s*:\s*"([^"]+)"/);
  if (m) return m[1].replace(/\\n/g, "\n");
  const m2 = html.match(/"description"\s*:\s*\{\s*"text"\s*:\s*"([^"]+)"/);
  if (m2) return m2[1].replace(/\\n/g, "\n");

  // Simple string variant present in m.facebook.com JSON blobs
  const m3 = html.match(/"listing_description"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (m3) return m3[1].replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\u003C/gi, "<").replace(/\\u003E/gi, ">");

  // og:description / name=description — two-step: find the <meta> tag first,
  // then pull content= from it, so other attributes in between don't break the match
  for (const tagPattern of [
    /<meta[^>]*property="og:description"[^>]*>/i,
    /<meta[^>]*name="description"[^>]*>/i,
  ]) {
    const tagMatch = html.match(tagPattern);
    if (tagMatch) {
      const contentMatch = tagMatch[0].match(/content="([^"]+)"/i);
      if (contentMatch) {
        return contentMatch[1]
          .replace(/&amp;/g, "&")
          .replace(/&#039;/g, "'")
          .replace(/&quot;/g, '"')
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .trim();
      }
    }
  }

  return undefined;
}

async function fetchDescriptionFromMobileHtml(listingId: string): Promise<string | undefined> {
  try {
    const res = await fetchWithTimeout(`https://m.facebook.com/marketplace/item/${listingId}/`, {
      method: "GET",
      headers: {
        "user-agent": "Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.91 Mobile Safari/537.36",
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
      },
      ...(proxyUrls.length ? { agent: getProxyAgent() } : {}),
    });

    console.warn(`[marketplace:mobileHtml] ${listingId} → HTTP ${res.status}, url=${res.url}`);

    if (res.status !== 200) return undefined;

    const html = await res.text();
    console.warn(`[marketplace:mobileHtml] html length=${html.length}, preview=${html.slice(0, 300).replace(/\n/g, " ")}`);

    const desc = extractDescriptionFromHtml(html);
    console.warn(`[marketplace:mobileHtml] extracted description=${desc ? JSON.stringify(desc.slice(0, 120)) : "null"}`);
    return desc;
  } catch (err) {
    console.warn(`[marketplace:mobileHtml] fetch error for ${listingId}:`, err);
    return undefined;
  }
}


function parseMarketplacePrice(value: any, formattedText?: string): number | null {
  // Explicit 0 means "Accepts Offers" on Facebook Marketplace — preserve it.
  if (value === 0 || value === "0") return 0;

  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;

  if (typeof formattedText === "string") {
    const stripped = formattedText.replace(/[^0-9.]/g, "");
    if (stripped === "0") return 0;
    const parsed = Number(stripped);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }

  // Price field was absent — not the same as "Accepts Offers"
  return null;
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

  return {
    ...searchMatch,
    ...detailListing,
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
    price: parseMarketplacePrice(target?.listing_price?.amount, target?.formatted_price?.text ?? target?.listing_price?.formatted_amount),
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

  return fetchWithTimeout(GRAPHQL_URL, {
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
    ...(proxyUrls.length ? { agent: getProxyAgent() } : {}),
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

  try {
    const [containerRes, mediaRes] = await Promise.all([
      makeGraphqlRequest(listingId, MARKETPLACE_PDP_CONTAINER_DOC_ID, "MarketplacePDPContainerQuery", containerVars),
      makeGraphqlRequest(listingId, MARKETPLACE_PDP_MEDIA_DOC_ID, "MarketplacePDPC2CMediaViewerWithImagesQuery", { targetId: listingId }),
    ]);

    if (containerRes.status !== 200) {
      console.warn(`[marketplace:containerQuery] HTTP ${containerRes.status} for listing ${listingId}`);
      return null;
    }

    const containerJson = await containerRes.json() as any;
    const details = containerJson?.data?.viewer?.marketplace_product_details_page ?? null;

    if (!details?.target?.marketplace_listing_title) {
      console.warn(`[marketplace:containerQuery] No listing data in response for ${listingId}`);
      return null;
    }

    let media: any = null;
    if (mediaRes.status === 200) {
      const mediaJson = await mediaRes.json() as any;
      media = mediaJson?.data?.viewer?.marketplace_product_details_page ?? null;
    } else {
      console.warn(`[marketplace:mediaQuery] HTTP ${mediaRes.status} for listing ${listingId}`);
    }

    return { details, media };
  } catch (err) {
    console.warn(`[marketplace:containerQuery] Failed for ${listingId}:`, err);
    return null;
  }
}

export async function getMarketplaceListingByGraphqlForAnalysis(listingId: string): Promise<Listing> {
  const result = await fetchMarketplaceListingByContainerQuery(listingId);

  if (!result) {
    throw new Error("Marketplace listing unavailable or could not be retrieved.");
  }

  const listing = buildMarketplaceListingFromProductDetails(listingId, result.details, result.media);

  if (!listing.description) {
    const desc = await fetchDescriptionFromMobileHtml(listingId);
    if (desc) return { ...listing, description: desc, fullDescription: desc };
  }

  return listing;
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

const MARKETPLACE_SEARCH_IMAGE_ENRICHMENT_CONCURRENCY = 4;

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

async function fetchMarketplaceListingByMbasicHtml(listingId: string): Promise<Listing> {
  const res = await fetch(`https://mbasic.facebook.com/marketplace/item/${listingId}/`, {
    method: "GET",
    headers: {
      "user-agent": "Mozilla/5.0 (Linux; Android 9; SM-G960F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/74.0.3729.157 Mobile Safari/537.36",
      "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9",
    },
    ...(proxyUrls.length ? { agent: getProxyAgent() } : {}),
  });

  if (res.status !== 200) {
    throw new Error(`Marketplace fetch failed: HTTP ${res.status}`);
  }

  const html = await res.text();
  const images = extractImagesFromHtml(html, listingId);
  const description = extractDescriptionFromHtml(html);
  const title = extractTitleFromHtml(html) ?? "Marketplace Listing";
  const price = extractPriceFromHtml(html);

  return {
    id: listingId,
    source: "marketplace",
    title,
    price,
    currency: "USD",
    url: `https://www.facebook.com/marketplace/item/${listingId}`,
    images,
    description,
    fullDescription: description,
  };
}

async function fetchMarketplaceListingWithCanonicalImages(listingId: string): Promise<Listing> {
  try {
    return await getMarketplaceListingByGraphqlForAnalysis(listingId);
  } catch (err) {
    console.warn(`[marketplace] canonical image fetch failed for ${listingId}, falling back to mbasic HTML`, err);
    return fetchMarketplaceListingByMbasicHtml(listingId);
  }
}

export async function getMarketplaceListing(listingId: string): Promise<Partial<Listing>> {
  try {
    const listing = await fetchMarketplaceListingWithCanonicalImages(listingId);
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
  return fetchMarketplaceListingWithCanonicalImages(listingId);
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
