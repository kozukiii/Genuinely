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

function getFbCookie() {
  const cookieParts = [
    process.env.FB_C_USER ? `c_user=${process.env.FB_C_USER}` : "",
    process.env.FB_XS ? `xs=${decodeURIComponent(process.env.FB_XS)}` : "",
    process.env.FB_DATR ? `datr=${process.env.FB_DATR}` : "",
    process.env.FB_SB ? `sb=${process.env.FB_SB}` : "",
  ].filter(Boolean);

  return cookieParts.join("; ");
}

function getMarketplacePermalinkHeaders(cookie: string) {
  return {
    "user-agent": FB_DESKTOP_USER_AGENT,
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
    "cache-control": "max-age=0",
    "upgrade-insecure-requests": "1",
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    "sec-fetch-user": "?1",
    ...(cookie ? { cookie } : {}),
  };
}

const latLngCache = new Map<string, { lat: number; lng: number; expiresAt: number }>();

async function getLatLng(location: string) {
  const key = location.toLowerCase().trim();
  const cached = latLngCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return { lat: cached.lat, lng: cached.lng };

  const body = new URLSearchParams({
    variables: JSON.stringify({
      params: {
        caller: "MARKETPLACE",
        page_category: ["CITY", "SUBCITY", "NEIGHBORHOOD", "POSTAL_CODE"],
        query: location,
      },
    }),
    doc_id: "5585904654783609",
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

  const raw = await res.text();
  const json = JSON.parse(raw);

  const first =
    json?.data?.city_street_search?.street_results?.edges?.[0]?.node;

  const result = {
    lat: first?.location?.latitude,
    lng: first?.location?.longitude,
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

  if (!enrichImages || listings.length === 0) {
    return listings;
  }

  return enrichMarketplaceSearchListings(listings);
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
  const m = html.match(/"redacted_description"\s*:\s*\{\s*"text"\s*:\s*"([^"]+)"/);
  if (m) return m[1].replace(/\\n/g, "\n");
  const m2 = html.match(/"description"\s*:\s*\{\s*"text"\s*:\s*"([^"]+)"/);
  if (m2) return m2[1].replace(/\\n/g, "\n");
  return undefined;
}

function collectMarketplaceProductDetails(node: any, hits: any[]) {
  if (!node || typeof node !== "object") return;

  const details = node?.data?.viewer?.marketplace_product_details_page;
  if (details) hits.push(details);

  if (Array.isArray(node)) {
    for (const item of node) collectMarketplaceProductDetails(item, hits);
    return;
  }

  for (const value of Object.values(node)) {
    collectMarketplaceProductDetails(value, hits);
  }
}

function extractMarketplaceProductDetailPages(html: string): any[] {
  const hits: any[] = [];
  const scriptPattern = /<script type="application\/json"[^>]*data-sjs[^>]*>([\s\S]*?)<\/script>/g;

  for (const match of html.matchAll(scriptPattern)) {
    const scriptText = match[1];
    if (!scriptText) continue;

    try {
      collectMarketplaceProductDetails(JSON.parse(scriptText), hits);
    } catch {
      // Ignore unrelated bootstrap blobs that are not valid standalone JSON.
    }
  }

  return hits;
}

function getMarketplacePayloadId(payload: any): string | null {
  const id = payload?.target?.id ?? payload?.marketplace_listing_renderable_target?.id;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

function pickMarketplaceProductDetailPages(listingId: string, payloads: any[]) {
  const matching = payloads.filter((payload) => getMarketplacePayloadId(payload) === listingId);

  const details =
    matching.find((payload) => typeof payload?.target?.marketplace_listing_title === "string") ??
    null;

  const media =
    matching.find((payload) => Array.isArray(payload?.target?.listing_photos)) ??
    null;

  return { details, media };
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

function collectExternalMarkLinkUrls(node: unknown, urls: string[], depth = 0, visited = new Set<unknown>()): void {
  if (depth > 12 || !node || typeof node !== "object" || visited.has(node)) return;
  visited.add(node);

  if (!Array.isArray(node)) {
    const obj = node as Record<string, unknown>;
    if (obj.__typename === "ExternalMarkLink" && typeof obj.url === "string") {
      urls.push(obj.url);
      return; // no need to recurse further into this node
    }
    for (const value of Object.values(obj)) {
      collectExternalMarkLinkUrls(value, urls, depth + 1, visited);
    }
  } else {
    for (const item of node) {
      collectExternalMarkLinkUrls(item, urls, depth + 1, visited);
    }
  }
}

function extractExternalMarkLinkUrlsFromHtml(html: string): string[] {
  const urls: string[] = [];
  const scriptPattern = /<script type="application\/json"[^>]*data-sjs[^>]*>([\s\S]*?)<\/script>/g;

  for (const match of html.matchAll(scriptPattern)) {
    try {
      const parsed = JSON.parse(match[1]);
      collectExternalMarkLinkUrls(parsed, urls);
    } catch {}
  }

  return urls;
}

async function followFbRedirectForEbayId(redirectUrl: string): Promise<string | null> {
  try {
    const res = await fetch(redirectUrl, {
      method: "GET",
      redirect: "manual",
      headers: { "user-agent": FB_DESKTOP_USER_AGENT },
    });

    const location = res.headers.get("location") ?? "";
    const m = location.match(/ebay\.com\/itm\/(?:[^/?#]+\/)?(\d{8,})/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export async function getEbayCrossListingId(listingId: string): Promise<string | null> {
  const cookie = getFbCookie();
  if (!cookie) return null;

  try {
    const res = await fetchWithTimeout(`https://www.facebook.com/marketplace/item/${listingId}/`, {
      method: "GET",
      headers: getMarketplacePermalinkHeaders(cookie),
      ...(proxyUrls.length ? { agent: getProxyAgent() } : {}),
    });
    if (res.status !== 200) return null;

    const html = await res.text();

    // First pass: look for a direct eBay item URL in the page
    const directMatch = html.match(/ebay\.com(?:\/|\\\/|%2F)itm(?:\/|\\\/|%2F)(?:[^"' \\<\s]+(?:\/|\\\/|%2F))?(\d{8,})/);
    if (directMatch) return directMatch[1];

    // Second pass: find ExternalMarkLink objects (the "Buy now on eBay" CTA)
    // and follow any Facebook redirect URLs to retrieve the eBay item ID
    const externalUrls = extractExternalMarkLinkUrlsFromHtml(html);
    for (const url of externalUrls) {
      if (/facebook\.com(?:\/|\\\/|%2F)l(?:\/|\\\/|%2F)/.test(url)) {
        const cleanUrl = url.replace(/\\\//g, "/");
        const ebayId = await followFbRedirectForEbayId(cleanUrl);
        if (ebayId) return ebayId;
      }
    }

    return null;
  } catch (err) {
    console.warn(`[marketplace:crossListing] Failed to check eBay cross-listing for ${listingId}:`, err);
    return null;
  }
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

async function fetchMarketplaceListingByPermalinkHtml(listingId: string): Promise<Listing> {
  const cookie = getFbCookie();
  if (!cookie) {
    throw new Error("Marketplace auth cookies are not configured.");
  }

  const res = await fetch(`https://www.facebook.com/marketplace/item/${listingId}/`, {
    method: "GET",
    headers: getMarketplacePermalinkHeaders(cookie),
    ...(proxyUrls.length ? { agent: getProxyAgent() } : {}),
  });

  if (res.status !== 200) {
    throw new Error(`Marketplace permalink fetch failed: HTTP ${res.status}`);
  }

  const html = await res.text();
  const payloads = extractMarketplaceProductDetailPages(html);
  const { details, media } = pickMarketplaceProductDetailPages(listingId, payloads);

  if (!details?.target?.marketplace_listing_title) {
    const pageTitle = extractTitleFromHtml(html) ?? "Unknown page";
    throw new Error(`Marketplace listing unavailable or Facebook returned an unexpected page (${pageTitle}).`);
  }

  return buildMarketplaceListingFromProductDetails(listingId, details, media);
}

export async function getMarketplaceListingByGraphqlForAnalysis(listingId: string): Promise<Listing> {
  const result = await fetchMarketplaceListingByContainerQuery(listingId);

  if (result) {
    return buildMarketplaceListingFromProductDetails(listingId, result.details, result.media);
  }

  // Fall back to authenticated HTML permalink fetch
  return fetchMarketplaceListingByPermalinkHtml(listingId);
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
  limit = 10,
  enrichImages = true,
}: {
  query: string;
  location: string;
  limit?: number;
  enrichImages?: boolean;
}) {
  const { lat, lng } = await getLatLng(location);

  if (lat == null || lng == null) {
    throw new Error("Location lookup failed");
  }

  return searchMarketplaceListingsByLatLng({
    query,
    lat,
    lng,
    limit,
    enrichImages,
  });
}

export const searchMarketplaceNormalized = searchMarketplaceListings;
