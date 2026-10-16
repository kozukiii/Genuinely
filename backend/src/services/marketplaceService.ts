import fetch from "node-fetch";
import type { Listing } from "../types/listing";
import { randomUUID } from "node:crypto";
import { MarketplaceResponseError, readMarketplaceResponse } from "./marketplaceResponse";
import { lookupMarketplaceCity, lookupMarketplaceZip } from "./marketplaceLocation";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { HttpsProxyAgent } = require("https-proxy-agent");

const proxyUrls = process.env.PROXY_URL
  ? process.env.PROXY_URL.split(",").map((s) => s.trim()).filter(Boolean)
  : [];

console.info("[marketplace:proxy-config]", JSON.stringify({
  configuredProxyCount: proxyUrls.length,
  proxies: proxyUrls.map((value, index) => {
    try {
      const parsed = new URL(value);
      return { index: index + 1, validHttpUrl: ["http:", "https:"].includes(parsed.protocol) && Boolean(parsed.hostname), usernamePresent: Boolean(parsed.username), passwordPresent: Boolean(parsed.password) };
    } catch {
      return { index: index + 1, validHttpUrl: false, usernamePresent: false, passwordPresent: false };
    }
  }),
}));

const FETCH_TIMEOUT_MS = 12_000;
const FACEBOOK_TIMEOUT_MS = 8_000;
const FACEBOOK_BODY_TIMEOUT_MS = 8_000;
const MARKETPLACE_PDP_BODY_TIMEOUT_MS = 20_000;
const GRAPHQL_URL = "https://www.facebook.com/api/graphql/";
const FB_GRAPHQL_USER_AGENT = "Mozilla/5.0";

let marketplaceRetryAt = 0;
let marketplaceDenialReason: "rate-limited" | "access-denied" = "rate-limited";

function fetchWithTimeout(
  url: string,
  options: Parameters<typeof fetch>[1],
  timeoutMs = FETCH_TIMEOUT_MS,
): ReturnType<typeof fetch> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal as any }).finally(() => clearTimeout(timer));
}

async function requestMarketplaceGraphql(
  options: Parameters<typeof fetch>[1],
  bodyTimeoutMs = FACEBOOK_BODY_TIMEOUT_MS,
) {
  if (Date.now() < marketplaceRetryAt) {
    const retryAfterMs = marketplaceRetryAt - Date.now();
    console.warn("[marketplace:backoff]", JSON.stringify({ reason: marketplaceDenialReason, retryAfterSeconds: Math.ceil(retryAfterMs / 1000), configurationReviewRequired: marketplaceDenialReason === "access-denied" }));
    throw new MarketplaceResponseError("Marketplace is backing off after an upstream denial", true, retryAfterMs);
  }

  // Honor the configured transport on the first request. Never race another
  // proxy or direct egress after a denial; the first configured proxy is used.
  const proxyUrl = proxyUrls[0] ?? null;
  let agent;
  let proxyAuthorizationConfigured = false;
  if (proxyUrl) {
    try {
      const parsed = new URL(proxyUrl);
      if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) throw new Error();
      proxyAuthorizationConfigured = Boolean(parsed.username || parsed.password);
      agent = new HttpsProxyAgent(proxyUrl);
    } catch {
      throw new MarketplaceResponseError("Marketplace proxy configuration requires a valid HTTP(S) URL", false);
    }
  }
  const metadata = {
    requestId: randomUUID().slice(0, 12), phase: "initial" as const,
    route: proxyUrl ? "proxy" as const : "direct" as const,
    proxyIndex: proxyUrl ? 1 : null,
    configuredProxyCount: proxyUrls.length, proxyAuthorizationConfigured,
  };
  try {
    const response = await fetchWithTimeout(GRAPHQL_URL, { ...options, ...(agent ? { agent } : {}) }, FACEBOOK_TIMEOUT_MS);
    const json = await readMarketplaceResponse<any>(response, metadata, bodyTimeoutMs);
    return { status: response.status, json };
  } catch (error) {
    if (error instanceof MarketplaceResponseError) {
      if (error.accessDenied) {
        const retryAt = Date.now() + (error.retryAfterMs || 60_000);
        if (retryAt > marketplaceRetryAt) {
          marketplaceRetryAt = retryAt;
          marketplaceDenialReason = error.retryAfterMs > 0 ? "rate-limited" : "access-denied";
        }
      }
      throw error;
    }
    console.warn("[marketplace:request]", JSON.stringify({ ...metadata, outcome: "transport-error" }));
    throw new MarketplaceResponseError("Marketplace request transport failed", false);
  }
}

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
    buyLocation: { latitude: lat, longitude: lng },
    contextual_data: null,
    count: limit,
    cursor: null,
    params: {
      bqf: {
        callsite: "COMMERCE_MKTPLACE_WWW",
        query,
      },
      browse_request_params: {
        commerce_enable_local_pickup: true,
        commerce_enable_shipping: true,
        commerce_search_and_rp_available: true,
        commerce_search_and_rp_category_id: [],
        commerce_search_and_rp_condition: null,
        commerce_search_and_rp_ctime_days: null,
        filter_location_latitude: lat,
        filter_location_longitude: lng,
        filter_price_lower_bound: 0,
        filter_price_upper_bound: 214748364700,
        filter_radius_km: radiusKm,
      },
      custom_request_params: {
        browse_context: null,
        contextual_filters: [],
        referral_code: null,
        referral_ui_component: null,
        saved_search_strid: null,
        search_vertical: "C2C",
        seo_url: null,
        serp_landing_settings: { virtual_category_id: "" },
        surface: "SEARCH",
        virtual_contextual_filters: [],
      },
    },
    savedSearchID: null,
    savedSearchQuery: query,
    scale: 1,
    shouldDeferNonCritical: false,
    shouldIncludePopularSearches: true,
    topicPageParams: { location_id: null, url: null },
    __relay_internal__pv__GHLShouldChangeMarketplaceSponsoredDataFieldNamerelayprovider: false,
  };

  const body = new URLSearchParams({
    variables: JSON.stringify(variables),
    doc_id: "7111939778879383",
    fb_api_caller_class: "RelayModern",
    fb_api_req_friendly_name: "CometMarketplaceSearchContentContainerQuery",
    server_timestamps: "true",
    __a: "1",
    __user: "0",
    __comet_req: "15",
  });

  const { json } = await requestMarketplaceGraphql({
    method: "POST",
    headers: {
      "user-agent": FB_GRAPHQL_USER_AGENT,
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (Array.isArray(json?.errors) && json.errors.length > 0) {
    throw new MarketplaceResponseError(`Marketplace GraphQL search failed (${json.errors.length} errors; see safe response diagnostics)`, false);
  }
  if (!json?.data?.marketplace_search?.feed_units?.edges) {
    throw new Error("Marketplace search response did not contain listing edges");
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

  // Resolve fallback city centers locally; listings with coordinates need no lookup.
  const cityKeys = new Map<string, { lat: number; lng: number } | null>();
  for (const l of listings) {
    if (l.raw?.location?.latitude != null && l.raw?.location?.longitude != null &&
        Number.isFinite(Number(l.raw.location.latitude)) && Number.isFinite(Number(l.raw.location.longitude))) continue;
    const city = l.raw?.location?.reverse_geocode?.city;
    const state = l.raw?.location?.reverse_geocode?.state;
    if (city && state) cityKeys.set(`${city}|${state}`, null);
  }
  for (const key of cityKeys.keys()) {
    const [city, state] = key.split("|");
    cityKeys.set(key, lookupMarketplaceCity(city, state));
  }

  const filtered = listings.filter((l: any) => {
    const listingLat = Number(l.raw?.location?.latitude);
    const listingLng = Number(l.raw?.location?.longitude);
    if (l.raw?.location?.latitude != null && l.raw?.location?.longitude != null &&
        Number.isFinite(listingLat) && Number.isFinite(listingLng)) {
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
  "__relay_internal__pv__MarketplacePDPCometSimilarListingsrelayprovider": false,
  "__relay_internal__pv__MarketplacePDPShouldShowRelatedSearchesrelayprovider": true,
  "__relay_internal__pv__MarketplacePDPShouldShowLoggedOutSellerTrustrelayprovider": false,
  "__relay_internal__pv__ShouldUpdateMarketplaceBoostListingBoostedStatusrelayprovider": false,
  "__relay_internal__pv__CometUFISingleLineUFIrelayprovider": false,
  "__relay_internal__pv__CometUFIShareActionMigrationrelayprovider": true,
  "__relay_internal__pv__CometUFIReactionsEnableShortNamerelayprovider": false,
  "__relay_internal__pv__CometUFICommentAutoTranslationTyperelayprovider": "AUTO_TRANSLATE",
  "__relay_internal__pv__CometUFICommentAvatarStickerAnimatedImagerelayprovider": false,
  "__relay_internal__pv__CometUFICommentActionLinksRewriteEnabledrelayprovider": false,
  "__relay_internal__pv__IsWorkUserrelayprovider": false,
  "__relay_internal__pv__GHLShouldChangeSponsoredDataFieldNamerelayprovider": false,
  "__relay_internal__pv__GHLShouldChangeAdIdFieldNamerelayprovider": false,
  "__relay_internal__pv__CometUFI_dedicated_comment_routable_dialog_gkrelayprovider": true,
  "__relay_internal__pv__MarketplacePDPShouldShowBSGRecommendationsrelayprovider": false,
  "__relay_internal__pv__MarketplacePDPJobShouldShowSharedGroupsSectionrelayprovider": false,
  "__relay_internal__pv__MarketplacePDPJobIsShareToGroupsEnabledOnCometrelayprovider": false,
};

const MARKETPLACE_PDP_MEDIA_DOC_ID = "10059604367394414";

async function makeGraphqlRequest(
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
    __a: "1",
    __user: "0",
    __comet_req: "15",
  });

  const options = {
    method: "POST",
    headers: {
      "user-agent": FB_GRAPHQL_USER_AGENT,
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
  };

  return requestMarketplaceGraphql(options, MARKETPLACE_PDP_BODY_TIMEOUT_MS);
}

async function fetchMarketplaceListingByContainerQuery(listingId: string): Promise<{ details: any; media: any } | null> {
  const containerVars = {
    targetId: listingId,
    feedLocation: "MARKETPLACE_MEGAMALL",
    feedbackSource: 56,
    scale: 1,
    useDefaultActor: false,
    referralSurfaceString: "search",
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

      const containerJson = containerRes.json;
      const details = containerJson?.data?.viewer?.marketplace_product_details_page ?? null;

      if (!details?.target?.marketplace_listing_title) {
        console.warn(`[marketplace:containerQuery] No listing data in response for ${listingId}`);
        if (attempt < 1) continue;
        return null;
      }

      // The media query carries the full photo gallery; the container only has
      // the primary thumbnail. Anything other than a 200 with a populated media
      // payload would leave only the primary image. Retry incomplete data on
      // the same configured transport; explicit denials already stop in the
      // shared response handler and must never trigger another route.
      let media: any = null;
      if (mediaRes.status === 200) {
        const mediaJson = mediaRes.json;
        media = mediaJson?.data?.viewer?.marketplace_product_details_page ?? null;
      }

      if (!media) {
        console.warn(`[marketplace:mediaQuery] no media for listing ${listingId} (HTTP ${mediaRes.status})`);
        if (attempt < 1) continue;
        // Out of retries: return the degraded listing rather than dropping it entirely.
      }

      return { details, media };
    } catch (err: any) {
      console.warn(`[marketplace:containerQuery] Failed for ${listingId} (attempt ${attempt + 1}):`, err);
      if (err instanceof MarketplaceResponseError && err.accessDenied) return null;
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

  const resolved = lookupMarketplaceZip(locationText);

  if (!resolved) {
    console.warn("[marketplace:location]", JSON.stringify({ source: "local-us-zip", outcome: "not-found" }));
    throw new Error("Location lookup failed: enter a supported US ZIP code");
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
