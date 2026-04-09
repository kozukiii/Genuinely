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

export async function getLocationFromIp(ip: string): Promise<BuyerLocation | null> {
  // Skip private/loopback addresses
  if (!ip || ip === "127.0.0.1" || ip === "::1" || ip.startsWith("192.168.") || ip.startsWith("10.")) {
    return null;
  }

  const cached = cache.get(ip);
  if (cached && cached.expiresAt > Date.now()) return cached.loc;

  try {
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=status,countryCode,zip,city,region,lat,lon`, {
      signal: AbortSignal.timeout(3000),
    });
    const data: any = await res.json();
    if (data.status !== "success" || !data.countryCode) return null;

    const loc: BuyerLocation = {
      country: data.countryCode,
      zip: data.zip ?? "",
      city: readOptionalString(data.city),
      region: readOptionalString(data.region),
      lat: readOptionalNumber(data.lat),
      lng: readOptionalNumber(data.lon),
    };
    cache.set(ip, { loc, expiresAt: Date.now() + TTL_MS });
    return loc;
  } catch (err) {
    console.warn("[geoIp] lookup failed for", ip, err);
    return null;
  }
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
