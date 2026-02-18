// backend/src/utils/marketplaceApiClient.ts
import fetch from "node-fetch";

type QueryParams = Record<string, string | number | boolean | null | undefined>;

export class MarketplaceApiError extends Error {
  status: number;
  bodyText: string;

  constructor(message: string, status: number, bodyText: string) {
    super(message);
    this.name = "MarketplaceApiError";
    this.status = status;
    this.bodyText = bodyText;
  }
}

function buildQuery(params?: QueryParams) {
  const sp = new URLSearchParams();
  if (!params) return sp;

  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    sp.set(k, String(v));
  }
  return sp;
}

function getBaseUrl() {
  const base = process.env.MARKETPLACE_API_BASE_URL ?? "";
  if (!base) {
    throw new Error(
      "MARKETPLACE_API_BASE_URL is not set. (Marketplace is currently a stub.)"
    );
  }
  return base.replace(/\/+$/, "");
}

export async function marketplaceRequest(
  path: string,
  params?: QueryParams,
  opts?: {
    method?: "GET" | "POST";
    body?: any;
    headers?: Record<string, string>;
    timeoutMs?: number;
  }
) {
  const baseUrl = getBaseUrl();

  const method = opts?.method ?? "GET";
  const timeoutMs = opts?.timeoutMs ?? 12_000;

  const url = new URL(`${baseUrl}${path.startsWith("/") ? path : `/${path}`}`);

  if (method === "GET") {
    const sp = buildQuery(params);
    sp.forEach((v, k) => url.searchParams.set(k, v));
  }

  // ✅ Build headers as Record<string,string> to satisfy HeadersInit
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...(opts?.headers ?? {}),
  };

  const apiKey = process.env.MARKETPLACE_API_KEY;
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url.toString(), {
      method,
      headers,
      body: method === "POST" ? JSON.stringify(opts?.body ?? params ?? {}) : undefined,
      signal: controller.signal as any,
    });

    const text = await res.text().catch(() => "");
    if (!res.ok) {
      throw new MarketplaceApiError(
        `Marketplace API HTTP ${res.status} ${res.statusText}`,
        res.status,
        text.slice(0, 500)
      );
    }

    if (!text) return null;

    try {
      return JSON.parse(text);
    } catch {
      throw new MarketplaceApiError(
        "Marketplace API returned non-JSON response",
        res.status,
        text.slice(0, 500)
      );
    }
  } finally {
    clearTimeout(t);
  }
}
