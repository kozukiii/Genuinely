import fetch from "node-fetch";

export interface BuyerLocation {
  country: string; // ISO 2-letter code, e.g. "US"
  zip: string;     // postal code, e.g. "54701"
  city?: string;
  region?: string;
  lat?: number;
  lng?: number;
}

export interface MarketplaceSearchLocation {
  location?: string;
  lat?: number;
  lng?: number;
}

// Simple in-process cache — one entry per IP, expires after 10 minutes.
const cache = new Map<string, { loc: BuyerLocation; expiresAt: number }>();
const TTL_MS = 10 * 60 * 1000;

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function readOptionalNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isPrivateOrLoopbackIp(ip: string): boolean {
  if (!ip) return true;
  if (ip === "127.0.0.1" || ip === "::1") return true;
  if (ip.startsWith("10.") || ip.startsWith("192.168.")) return true;

  // 172.16.0.0/12
  const m = ip.match(/^172\.(\d{1,3})\./);
  if (m) {
    const second = Number(m[1]);
    if (Number.isFinite(second) && second >= 16 && second <= 31) return true;
  }

  return false;
}

async function lookupIpApi(ip: string): Promise<BuyerLocation | null> {
  const res = await fetch(`http://ip-api.com/json/${ip}?fields=status,countryCode,zip,city,region,lat,lon`, {
    signal: AbortSignal.timeout(3000),
  });
  const data: any = await res.json();
  if (data.status !== "success" || !data.countryCode) return null;

  return {
    country: data.countryCode,
    zip: data.zip ?? "",
    city: readOptionalString(data.city),
    region: readOptionalString(data.region),
    lat: readOptionalNumber(data.lat),
    lng: readOptionalNumber(data.lon),
  };
}

async function lookupIpWhois(ip: string): Promise<BuyerLocation | null> {
  const res = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`, {
    signal: AbortSignal.timeout(3000),
  });
  const data: any = await res.json();
  if (data.success === false || !data.country_code) return null;

  return {
    country: String(data.country_code).toUpperCase(),
    zip: readOptionalString(data.postal) ?? "",
    city: readOptionalString(data.city),
    region: readOptionalString(data.region),
    lat: readOptionalNumber(data.latitude),
    lng: readOptionalNumber(data.longitude),
  };
}

export async function getLocationFromIp(ip: string): Promise<BuyerLocation | null> {
  // Skip private/loopback addresses
  if (isPrivateOrLoopbackIp(ip)) {
    return null;
  }

  const cached = cache.get(ip);
  if (cached && cached.expiresAt > Date.now()) return cached.loc;

  // Run both providers in parallel — bounds latency to max(3s, 3s) instead of 3s+3s.
  const [primaryResult, secondaryResult] = await Promise.allSettled([
    lookupIpApi(ip),
    lookupIpWhois(ip),
  ]);

  const primary = primaryResult.status === "fulfilled" ? primaryResult.value : null;
  const secondary = secondaryResult.status === "fulfilled" ? secondaryResult.value : null;

  // Prefer ip-api; fall back to ipwho.is if ip-api failed or returned nothing.
  let loc = primary ?? secondary;
  if (!loc) return null;

  // Augment zip from the other provider when ours is missing.
  const other = loc === primary ? secondary : primary;
  if (!loc.zip && other?.country === loc.country && other.zip) {
    loc = { ...loc, zip: other.zip };
  }

  cache.set(ip, { loc, expiresAt: Date.now() + TTL_MS });
  return loc;
}

export function extractClientIp(req: { ip?: string; headers: Record<string, string | string[] | undefined> }): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(",")[0];
    return first.trim();
  }
  return req.ip ?? "";
}

export function getMarketplaceSearchLocation(loc: BuyerLocation | null): MarketplaceSearchLocation | null {
  if (!loc) return null;

  const location = [loc.city, loc.region].filter(Boolean).join(", ") || loc.zip;
  const hasCoords = loc.lat != null && loc.lng != null;

  if (!location && !hasCoords) {
    return null;
  }

  return {
    ...(location ? { location } : {}),
    ...(loc.lat != null ? { lat: loc.lat } : {}),
    ...(loc.lng != null ? { lng: loc.lng } : {}),
  };
}
