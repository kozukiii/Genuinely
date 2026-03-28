import fetch from "node-fetch";
import type { Listing } from "../types/listing";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { HttpsProxyAgent } = require("https-proxy-agent");

const proxyUrls = process.env.PROXY_URL
  ? process.env.PROXY_URL.split(",").map((s) => s.trim()).filter(Boolean)
  : [];

function getProxyAgent() {
  if (proxyUrls.length === 0) return undefined;
  const url = proxyUrls[Math.floor(Math.random() * proxyUrls.length)];
  return new HttpsProxyAgent(url);
}

const GRAPHQL_URL = "https://www.facebook.com/api/graphql/";

function getFbCookie() {
  return [
    `c_user=${process.env.FB_C_USER}`,
    `xs=${decodeURIComponent(process.env.FB_XS ?? "")}`,
    `datr=${process.env.FB_DATR}`,
    `sb=${process.env.FB_SB}`,
  ].join("; ");
}

const FB_HEADERS = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "content-type": "application/x-www-form-urlencoded",
  "accept": "*/*, application/json",
  "accept-language": "en-US,en;q=0.9",
  "origin": "https://www.facebook.com",
  "referer": "https://www.facebook.com/marketplace/",
};

async function getLatLng(location: string) {
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

  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      "user-agent": "Mozilla/5.0",
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
    ...(proxyUrls.length ? { agent: getProxyAgent() } : {}),
  });

  const raw = await res.text();
  console.log(`[marketplace:getLatLng] status=${res.status} body=${raw.slice(0, 300)}`);
  const json = JSON.parse(raw);

  const first =
    json?.data?.city_street_search?.street_results?.edges?.[0]?.node;

  return {
    lat: first?.location?.latitude,
    lng: first?.location?.longitude,
  };
}

function extractMarketplaceImages(listing: any): string[] {
  const urls = new Set<string>();

  const pushIfValid = (url: any) => {
    if (typeof url === "string" && url.trim().startsWith("http")) {
      urls.add(url.trim());
    }
  };

  pushIfValid(listing?.primary_listing_photo?.image?.uri);

  const possibleArrays = [
    listing?.listing_photos,
    listing?.photos,
    listing?.all_photos,
    listing?.additional_photos,
    listing?.media,
    listing?.images,
  ];

  for (const arr of possibleArrays) {
    if (!Array.isArray(arr)) continue;

    for (const item of arr) {
      pushIfValid(item?.image?.uri);
      pushIfValid(item?.uri);
      pushIfValid(item?.url);
    }
  }

  return Array.from(urls);
}

function extractImagesFromHtml(html: string, _listingId: string): string[] {
  const byFilename = new Map<string, string>();
  const addUri = (raw: string) => {
    const url = raw.replace(/\\u0025/g, "%").replace(/\\\//g, "/").replace(/&amp;/g, "&");
    if (!url.startsWith("http")) return;
    if (!url.includes("scontent")) return;
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

export async function getMarketplaceListing(listingId: string): Promise<Partial<Listing>> {
  try {
    const cookie = [
      `c_user=${process.env.FB_C_USER}`,
      `xs=${decodeURIComponent(process.env.FB_XS ?? "")}`,
      `datr=${process.env.FB_DATR}`,
      `sb=${process.env.FB_SB}`,
    ].join("; ");

    const res = await fetch(`https://mbasic.facebook.com/marketplace/item/${listingId}/`, {
      method: "GET",
      headers: {
        "user-agent": "Mozilla/5.0 (Linux; Android 9; SM-G960F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/74.0.3729.157 Mobile Safari/537.36",
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        cookie,
      },
      ...(proxyUrls.length ? { agent: getProxyAgent() } : {}),
    });

    const html = await res.text();
    if (res.status !== 200) return {};

    const images = extractImagesFromHtml(html, listingId);
    const description = extractDescriptionFromHtml(html);
    return { images, description, fullDescription: description };
  } catch (err) {
    console.error("getMarketplaceListing error:", err);
    return {};
  }
}

export async function getMarketplaceListingFull(listingId: string): Promise<Listing> {
  const cookie = [
    `c_user=${process.env.FB_C_USER}`,
    `xs=${decodeURIComponent(process.env.FB_XS ?? "")}`,
    `datr=${process.env.FB_DATR}`,
    `sb=${process.env.FB_SB}`,
  ].join("; ");

  const res = await fetch(`https://mbasic.facebook.com/marketplace/item/${listingId}/`, {
    method: "GET",
    headers: {
      "user-agent": "Mozilla/5.0 (Linux; Android 9; SM-G960F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/74.0.3729.157 Mobile Safari/537.36",
      "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9",
      cookie,
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

export async function searchMarketplaceListings({
  query,
  location,
  limit = 10,
}: {
  query: string;
  location: string;
  limit?: number;
}) {
  const { lat, lng } = await getLatLng(location);

  if (lat == null || lng == null) {
    throw new Error("Location lookup failed");
  }

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
        filter_radius_km: 16,
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

  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      "user-agent": "Mozilla/5.0",
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
    ...(proxyUrls.length ? { agent: getProxyAgent() } : {}),
  });

  const json = await res.json();

  const edges = json?.data?.marketplace_search?.feed_units?.edges ?? [];

  return edges.map((edge: any) => {
    const listing = edge?.node?.listing;

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
      images: extractMarketplaceImages(listing),
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
}

export const searchMarketplaceNormalized = searchMarketplaceListings;