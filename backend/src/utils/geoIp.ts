import fetch from "node-fetch";

export interface BuyerLocation {
  country: string; // ISO 2-letter code, e.g. "US"
  zip: string;     // postal code, e.g. "54701"
}

// Simple in-process cache — one entry per IP, expires after 10 minutes.
const cache = new Map<string, { loc: BuyerLocation; expiresAt: number }>();
const TTL_MS = 10 * 60 * 1000;

export async function getLocationFromIp(ip: string): Promise<BuyerLocation | null> {
  // Skip private/loopback addresses
  if (!ip || ip === "127.0.0.1" || ip === "::1" || ip.startsWith("192.168.") || ip.startsWith("10.")) {
    return null;
  }

  const cached = cache.get(ip);
  if (cached && cached.expiresAt > Date.now()) return cached.loc;

  try {
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=status,countryCode,zip`, {
      signal: AbortSignal.timeout(3000),
    });
    const data: any = await res.json();
    if (data.status !== "success" || !data.countryCode) return null;

    const loc: BuyerLocation = {
      country: data.countryCode,
      zip: data.zip ?? "",
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
