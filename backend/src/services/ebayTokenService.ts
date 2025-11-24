import fetch from "node-fetch";

const EBAY_TOKEN_ENDPOINT = "https://api.ebay.com/identity/v1/oauth2/token";
const REFRESH_MARGIN_MS = 60 * 1000; // Refresh 1 minute before expiry

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

function getClientCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("EBAY_CLIENT_ID or EBAY_CLIENT_SECRET is missing");
  }

  return { clientId, clientSecret };
}

function getRefreshToken(): string {
  const refreshToken = process.env.EBAY_REFRESH_TOKEN;

  if (!refreshToken) {
    throw new Error("EBAY_REFRESH_TOKEN is missing");
  }

  return refreshToken;
}

function isTokenValid(): boolean {
  return Boolean(cachedToken && Date.now() < tokenExpiresAt - REFRESH_MARGIN_MS);
}

async function requestAccessToken(): Promise<{ access_token: string; expires_in: number }> {
  const { clientId, clientSecret } = getClientCredentials();
  const refreshToken = getRefreshToken();
  const scope =
    process.env.EBAY_SCOPE || "https://api.ebay.com/oauth/api_scope";

  const authHeader = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const response = await fetch(EBAY_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Basic ${authHeader}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope
    })
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `Failed to refresh eBay token: ${response.status} ${response.statusText} - ${errorBody}`
    );
  }

  const data = (await response.json()) as {
    access_token: string;
    expires_in: number;
  };

  if (!data.access_token || !data.expires_in) {
    throw new Error("Invalid token response from eBay");
  }

  return data;
}

export async function refreshEbayAccessToken(): Promise<string> {
  const { access_token, expires_in } = await requestAccessToken();
  cachedToken = access_token;
  tokenExpiresAt = Date.now() + expires_in * 1000;
  return cachedToken;
}

export async function getEbayAccessToken(): Promise<string> {
  if (isTokenValid()) {
    return cachedToken as string;
  }

  return refreshEbayAccessToken();
}

export async function warmUpEbayAccessToken(): Promise<void> {
  try {
    await refreshEbayAccessToken();
    console.log("🔄 eBay access token refreshed on startup");
  } catch (error) {
    console.error("Failed to refresh eBay access token on startup", error);
  }
}
