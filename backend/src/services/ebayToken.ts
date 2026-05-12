// backend/src/services/ebayToken.ts
import fs from "fs";
import path from "path";

type TokenCache = {
  access_token: string;
  expires_at: number; // unix seconds
};

const EBAY_DEFAULT_SCOPE = "https://api.ebay.com/oauth/api_scope";
const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const CACHE_PATH = path.join(DATA_DIR, "ebay_token.json");
const REFRESH_EARLY_SECONDS = 120; // refresh 2 min before expiry

const inMemory = new Map<string, TokenCache>();
const refreshPromises = new Map<string, Promise<string>>();

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function isValid(t: TokenCache | null) {
  return !!t?.access_token && !!t?.expires_at && t.expires_at - REFRESH_EARLY_SECONDS > nowSec();
}

function normalizeScopes(scopes: string | string[] = EBAY_DEFAULT_SCOPE) {
  const list = Array.isArray(scopes) ? scopes : scopes.split(/\s+/);
  const unique = Array.from(new Set(list.map((s) => s.trim()).filter(Boolean)));
  return unique.length ? unique.sort() : [EBAY_DEFAULT_SCOPE];
}

function scopeKey(scopes: string | string[] = EBAY_DEFAULT_SCOPE) {
  return normalizeScopes(scopes).join(" ");
}

function cachePathForScope(key: string) {
  if (key === EBAY_DEFAULT_SCOPE) return CACHE_PATH;

  const suffix = Buffer.from(key)
    .toString("base64")
    .replace(/[^a-zA-Z0-9]/g, "_");

  return path.join(DATA_DIR, `ebay_token_${suffix}.json`);
}

function readCache(key: string): TokenCache | null {
  try {
    const cachePath = cachePathForScope(key);
    if (!fs.existsSync(cachePath)) return null;
    const raw = fs.readFileSync(cachePath, "utf8");
    return JSON.parse(raw) as TokenCache;
  } catch {
    return null;
  }
}

function writeCache(key: string, t: TokenCache) {
  const cachePath = cachePathForScope(key);
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(t, null, 2), "utf8");
}

async function fetchNewToken(key: string): Promise<TokenCache> {
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
  body.set("scope", key);

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

export async function getEbayToken(scopes: string | string[] = EBAY_DEFAULT_SCOPE): Promise<string> {
  const key = scopeKey(scopes);

  // 1) memory
  const cachedMemory = inMemory.get(key) ?? null;
  if (isValid(cachedMemory)) return cachedMemory!.access_token;

  // 2) disk cache
  const cached = readCache(key);
  if (isValid(cached)) {
    inMemory.set(key, cached!);
    return cached!.access_token;
  }

  // 3) refresh (dedupe concurrent refresh calls)
  if (!refreshPromises.has(key)) {
    const refreshPromise = (async () => {
      const fresh = await fetchNewToken(key);
      inMemory.set(key, fresh);
      writeCache(key, fresh);
      return fresh.access_token;
    })().finally(() => {
      refreshPromises.delete(key);
    });

    refreshPromises.set(key, refreshPromise);
  }

  return refreshPromises.get(key)!;
}

