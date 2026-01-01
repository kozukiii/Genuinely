// backend/src/services/ebayToken.ts
import fs from "fs";
import path from "path";

type TokenCache = {
  access_token: string;
  expires_at: number; // unix seconds
};

const CACHE_PATH = path.join(process.cwd(), ".cache", "ebay_token.json");
const REFRESH_EARLY_SECONDS = 120; // refresh 2 min before expiry

let inMemory: TokenCache | null = null;
let refreshPromise: Promise<string> | null = null;

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function isValid(t: TokenCache | null) {
  return !!t?.access_token && !!t?.expires_at && t.expires_at - REFRESH_EARLY_SECONDS > nowSec();
}

function readCache(): TokenCache | null {
  try {
    if (!fs.existsSync(CACHE_PATH)) return null;
    const raw = fs.readFileSync(CACHE_PATH, "utf8");
    return JSON.parse(raw) as TokenCache;
  } catch {
    return null;
  }
}

function writeCache(t: TokenCache) {
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(t, null, 2), "utf8");
}

async function fetchNewToken(): Promise<TokenCache> {
  // Use YOUR EXISTING env names so you don't change .env
  const clientId = process.env.EBAY_APP_ID;     // your App ID
  const clientSecret = process.env.EBAY_CERT_ID; // your Cert ID
  const env = (process.env.EBAY_ENVIRONMENT || "production").toLowerCase();

  if (!clientId || !clientSecret) {
    throw new Error("Missing EBAY_APP_ID or EBAY_CERT_ID in backend/.env");
  }

  const tokenUrl =
    env === "sandbox"
      ? "https://api.sandbox.ebay.com/identity/v1/oauth2/token"
      : "https://api.ebay.com/identity/v1/oauth2/token";

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const body = new URLSearchParams();
  body.set("grant_type", "client_credentials");
  body.set("scope", "https://api.ebay.com/oauth/api_scope");

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`eBay token refresh failed (${res.status}): ${text}`);
  }

  const json = (await res.json()) as {
    access_token: string;
    expires_in: number;
  };

  return {
    access_token: json.access_token,
    expires_at: nowSec() + json.expires_in,
  };
}

export async function getEbayToken(): Promise<string> {
  // 1) memory
  if (isValid(inMemory)) return inMemory!.access_token;

  // 2) disk cache
  const cached = readCache();
  if (isValid(cached)) {
    inMemory = cached;
    return cached!.access_token;
  }

  // 3) refresh (dedupe concurrent refresh calls)
  if (!refreshPromise) {
    refreshPromise = (async () => {
      const fresh = await fetchNewToken();
      inMemory = fresh;
      writeCache(fresh);
      return fresh.access_token;
    })().finally(() => {
      refreshPromise = null;
    });
  }

  return refreshPromise;
}

