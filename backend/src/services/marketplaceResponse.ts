import type { Response } from "node-fetch";

export type MarketplaceRequestMetadata = {
  route: "direct" | "proxy";
  phase: "initial" | "fallback";
  requestId: string;
  proxyIndex: number | null;
  configuredProxyCount: number;
  proxyAuthorizationConfigured: boolean;
};

export class MarketplaceResponseError extends Error {
  constructor(message: string, readonly accessDenied: boolean, readonly retryAfterMs = 0) {
    super(message);
    this.name = "MarketplaceResponseError";
  }
}

// Never include response bodies, URLs, header values other than the media type,
// cookies, credentials, or the original JSON parser exception in diagnostics.
export async function readMarketplaceResponse<T>(
  response: Response,
  metadata: MarketplaceRequestMetadata,
  timeoutMs: number,
): Promise<T> {
  const rawType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  const contentType = rawType && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(rawType) && rawType.length < 80
    ? rawType : "unknown";
  const diagnostic = {
    ...metadata,
    status: response.status,
    contentType,
    proxyAuthenticatePresent: response.headers.has("proxy-authenticate"),
    wwwAuthenticatePresent: response.headers.has("www-authenticate"),
  };
  const retryAfter = response.headers.get("retry-after");
  const retryAfterMs = retryAfter && /^\d+$/.test(retryAfter.trim())
    ? Number(retryAfter) * 1000 : retryAfter ? Date.parse(retryAfter) - Date.now() : NaN;
  const cooldownMs = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : 60_000;
  if ([401, 403, 407, 429].includes(response.status)) {
    const rateLimited = response.status === 429;
    console.info("[marketplace:response]", JSON.stringify({
      ...diagnostic, bodyKind: "not-read", outcome: rateLimited ? "rate-limited" : "access-denied",
      ...(rateLimited ? { retryAfterSeconds: Math.ceil(cooldownMs / 1000) } : {}),
    }));
    (response.body as { destroy?: () => void } | null)?.destroy?.();
    throw new MarketplaceResponseError(`Marketplace ${rateLimited ? "rate limited" : "access denied"} (HTTP ${response.status}, ${metadata.route}, proxy index ${metadata.proxyIndex ?? "none"})`, true, rateLimited ? cooldownMs : 0);
  }
  let timer: NodeJS.Timeout | undefined;
  let text: string;
  try {
    text = await Promise.race([
      response.text(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new MarketplaceResponseError("Marketplace response body timed out", false);
          const body = response.body as { destroy?: (error: Error) => void } | null;
          body?.destroy?.(error);
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    const timedOut = error instanceof MarketplaceResponseError;
    console.warn("[marketplace:response]", JSON.stringify({ ...diagnostic, outcome: timedOut ? "body-timeout" : "body-read-failed" }));
    throw new MarketplaceResponseError(timedOut ? "Marketplace response body timed out" : "Marketplace response body could not be read", false);
  } finally {
    if (timer) clearTimeout(timer);
  }

  const trimmed = text.trim();
  const deniedBody = /^(unauthorized|forbidden|proxy authentication required|authentication required)[.!\s]*$/i.test(trimmed);
  let json: T | undefined;
  let parsed = false;
  try { json = JSON.parse(text) as T; parsed = true; } catch { /* Log a classification, never parser text. */ }
  const errors = parsed && json && typeof json === "object" && Array.isArray((json as { errors?: unknown }).errors)
    ? (json as unknown as { errors: Array<{ code?: unknown }> }).errors : [];
  const graphQLErrorCodes = [...new Set(errors.map(error => error?.code).filter((code): code is number => typeof code === "number" && Number.isInteger(code)))];
  const rateLimited = graphQLErrorCodes.includes(1675004);
  const bodyKind = deniedBody ? "access-denied" : parsed ? "json" : !trimmed ? "empty" : trimmed.startsWith("<") ? "html" : "non-json";
  console.info("[marketplace:response]", JSON.stringify({
    ...diagnostic, bodyKind, graphQLErrorCount: errors.length, graphQLErrorCodes,
    outcome: rateLimited ? "rate-limited" : deniedBody ? "access-denied" : response.ok && parsed ? "json" : "invalid-response",
    ...(rateLimited ? { retryAfterSeconds: Math.ceil(cooldownMs / 1000) } : {}),
  }));
  if (rateLimited) {
    throw new MarketplaceResponseError(`Marketplace rate limited (HTTP ${response.status}, ${metadata.route})`, true, cooldownMs);
  }
  if (deniedBody) {
    throw new MarketplaceResponseError(`Marketplace access denied (HTTP ${response.status}, ${metadata.route}, proxy index ${metadata.proxyIndex ?? "none"})`, true);
  }
  if (!response.ok || !parsed) {
    throw new MarketplaceResponseError(`Marketplace returned ${bodyKind} instead of usable JSON (HTTP ${response.status}, ${metadata.route})`, false);
  }
  return json as T;
}
