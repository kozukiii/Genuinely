// backend/src/services/stockxToken.ts
//
// StockX OAuth token manager. Mirrors ebayToken.ts (in-memory + disk cache,
// concurrent-refresh dedupe) but StockX only supports the authorization_code
// grant — there is no client_credentials option. So the flow is:
//
//   1. One-time: an admin hits /api/internal/stockx/auth-url, logs in on
//      StockX, and StockX redirects back to /api/internal/stockx/oauth/callback
//      with a ?code=. We exchange that for an access_token + refresh_token and
//      persist the refresh_token to data/stockx_token.json.
//   2. From then on: getStockXToken() returns a cached access_token, silently
//      refreshing it from the stored refresh_token whenever it is near expiry.
//
// The refresh_token can also be seeded from STOCKX_REFRESH_TOKEN so a deploy can
// be authorized without the browser handshake (e.g. copy the token off a box
// that already completed the handshake).
import fs from "fs";
import path from "path";

const ACCOUNTS_BASE = "https://accounts.stockx.com";
export const STOCKX_AUTHORIZE_URL = `${ACCOUNTS_BASE}/authorize`;
export const STOCKX_TOKEN_URL = `${ACCOUNTS_BASE}/oauth/token`;
export const STOCKX_AUDIENCE = "gateway.stockx.com";
export const STOCKX_SCOPE = "offline_access openid";

const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const CACHE_PATH = path.join(DATA_DIR, "stockx_token.json");
const REFRESH_EARLY_SECONDS = 120; // refresh 2 min before expiry

type TokenCache = {
  access_token: string;
  refresh_token: string;
  expires_at: number; // unix seconds
};

let inMemory: TokenCache | null = null;
let refreshPromise: Promise<string> | null = null;

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function accessValid(t: TokenCache | null): t is TokenCache {
  return !!t?.access_token && !!t?.expires_at && t.expires_at - REFRESH_EARLY_SECONDS > nowSec();
}

function readCache(): TokenCache | null {
  try {
    if (!fs.existsSync(CACHE_PATH)) return null;
    return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8")) as TokenCache;
  } catch {
    return null;
  }
}

function writeCache(t: TokenCache) {
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(t, null, 2), "utf8");
  inMemory = t;
}

function clientCredentials() {
  const clientId = process.env.STOCKX_CLIENT_ID;
  const clientSecret = process.env.STOCKX_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Missing STOCKX_CLIENT_ID or STOCKX_CLIENT_SECRET in backend/.env");
  }
  return { clientId, clientSecret };
}

export function stockxApiKey(): string {
  const key = process.env.STOCKX_API_KEY;
  if (!key) throw new Error("Missing STOCKX_API_KEY in backend/.env");
  return key;
}

/** The refresh token currently on hand, from disk cache or the env seed. */
function currentRefreshToken(): string | null {
  return inMemory?.refresh_token ?? readCache()?.refresh_token ?? process.env.STOCKX_REFRESH_TOKEN ?? null;
}

/** True once a refresh token exists (i.e. the one-time handshake is done). */
export function isStockXConnected(): boolean {
  return !!currentRefreshToken();
}

/**
 * Forget the stored StockX tokens so the next lookup requires a fresh
 * handshake. Clears both the in-memory cache and the persisted file. Note this
 * only clears OUR side — it does not end the StockX browser session, so to
 * switch accounts the user should also be re-prompted to log in (see the
 * prompt=login param on the authorize URL).
 */
export function disconnectStockX(): void {
  inMemory = null;
  refreshPromise = null;
  try {
    if (fs.existsSync(CACHE_PATH)) fs.unlinkSync(CACHE_PATH);
  } catch {
    /* best-effort */
  }
}

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
};

/**
 * Exchange an authorization code (from the OAuth redirect) for tokens and
 * persist them. Called by the /stockx/oauth/callback route during the one-time
 * handshake.
 */
export async function exchangeAuthCode(code: string, redirectUri: string): Promise<void> {
  const { clientId, clientSecret } = clientCredentials();

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
    audience: STOCKX_AUDIENCE,
  });

  const res = await fetch(STOCKX_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`StockX auth-code exchange failed (${res.status}): ${await res.text()}`);
  }

  const json = (await res.json()) as TokenResponse;
  if (!json.refresh_token) {
    throw new Error("StockX did not return a refresh_token — ensure scope includes offline_access");
  }

  writeCache({
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: nowSec() + json.expires_in,
  });
}

async function refreshAccessToken(refreshToken: string): Promise<TokenCache> {
  const { clientId, clientSecret } = clientCredentials();

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    audience: STOCKX_AUDIENCE,
  });

  const res = await fetch(STOCKX_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`StockX token refresh failed (${res.status}): ${await res.text()}`);
  }

  const json = (await res.json()) as TokenResponse;
  return {
    access_token: json.access_token,
    // StockX may rotate the refresh token; keep the new one if present.
    refresh_token: json.refresh_token ?? refreshToken,
    expires_at: nowSec() + json.expires_in,
  };
}

/**
 * Returns a valid StockX access token, refreshing from the stored refresh
 * token when needed. Throws if the one-time handshake has never been done.
 */
export async function getStockXToken(): Promise<string> {
  // 1) memory
  if (accessValid(inMemory)) return inMemory.access_token;

  // 2) disk cache
  const cached = readCache();
  if (accessValid(cached)) {
    inMemory = cached;
    return cached.access_token;
  }

  // 3) refresh (dedupe concurrent callers)
  if (!refreshPromise) {
    refreshPromise = (async () => {
      const refreshToken = currentRefreshToken();
      if (!refreshToken) {
        throw new Error("StockX not connected — complete the OAuth handshake at /api/internal/stockx/auth-url");
      }
      const fresh = await refreshAccessToken(refreshToken);
      writeCache(fresh);
      return fresh.access_token;
    })().finally(() => {
      refreshPromise = null;
    });
  }

  return refreshPromise;
}
