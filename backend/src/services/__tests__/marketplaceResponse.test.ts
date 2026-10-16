import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Response } from "node-fetch";
import { MarketplaceResponseError, readMarketplaceResponse, type MarketplaceRequestMetadata } from "../marketplaceResponse";

const metadata: MarketplaceRequestMetadata = {
  route: "proxy", phase: "fallback", requestId: "test-request", proxyIndex: 1,
  configuredProxyCount: 1, proxyAuthorizationConfigured: true,
};
const diagnostics = () => vi.mocked(console.info).mock.calls
  .filter(([prefix]) => prefix === "[marketplace:response]")
  .map(([, message]) => JSON.parse(String(message)));
beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("safe Marketplace response diagnostics", () => {
  it("identifies a proxy authentication response without exposing sensitive fields", async () => {
    const response = new Response("unauthorized", { status: 407, url: "https://fixture-user:fixture-secret@facebook.test/", headers: {
      "content-type": "text/plain; secret=fixture-secret",
      "proxy-authenticate": 'Basic realm="fixture-secret"',
      "set-cookie": "fixture-cookie=fixture-secret", "authorization": "fixture-secret",
    } });
    const readBody = vi.spyOn(response, "text");
    const error = await readMarketplaceResponse(response, metadata, 100).catch(error => error);
    expect(error).toBeInstanceOf(MarketplaceResponseError);
    expect(error.accessDenied).toBe(true);
    expect(diagnostics()).toContainEqual(expect.objectContaining({
      status: 407, route: "proxy", proxyIndex: 1, contentType: "text/plain", bodyKind: "not-read",
      proxyAuthenticatePresent: true, wwwAuthenticatePresent: false, proxyAuthorizationConfigured: true,
    }));
    expect(readBody).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(console.info).mock.calls) + error.message).not.toMatch(/fixture-secret|fixture-user|fixture-cookie|facebook\.test/);
  });
  it("recognizes the reported plaintext denial even with HTTP 200", async () => {
    await expect(readMarketplaceResponse(new Response("unauthorized"), metadata, 100))
      .rejects.toMatchObject({ accessDenied: true });
  });
  it("honors HTTP Retry-After without logging its raw value", async () => {
    await expect(readMarketplaceResponse(new Response("rate limited", { status: 429, headers: { "retry-after": "120" } }), metadata, 100))
      .rejects.toMatchObject({ accessDenied: true, retryAfterMs: 120_000 });
    expect(diagnostics()).toContainEqual(expect.objectContaining({ outcome: "rate-limited", retryAfterSeconds: 120 }));
  });
  it("classifies the observed GraphQL rate limit without exposing error messages", async () => {
    const response = new Response(JSON.stringify({ errors: [{ code: 1675004, message: "fixture-error-secret" }] }));
    const error = await readMarketplaceResponse(response, metadata, 100).catch(error => error);
    expect(error).toMatchObject({ accessDenied: true, retryAfterMs: 60_000 });
    expect(JSON.stringify(vi.mocked(console.info).mock.calls) + error.message).not.toContain("fixture-error-secret");
  });
  it("rejects malformed responses without echoing body or JSON parser text", async () => {
    const error = await readMarketplaceResponse(new Response("fixture-sensitive-body"), metadata, 100).catch(error => error);
    expect(error.accessDenied).toBe(false);
    expect(error.message).toContain("non-json");
    expect(JSON.stringify(vi.mocked(console.info).mock.calls) + error.message).not.toContain("fixture-sensitive-body");
  });
  it("returns normal GraphQL JSON unchanged", async () => {
    const json = { data: { marketplace_search: { feed_units: { edges: [] } } } };
    await expect(readMarketplaceResponse(new Response(JSON.stringify(json), { headers: { "content-type": "application/json" } }), metadata, 100)).resolves.toEqual(json);
  });
  it("does not expose failed stream error messages", async () => {
    const response = new Response();
    vi.spyOn(response, "text").mockRejectedValue(new Error("fixture-stream-secret"));
    const error = await readMarketplaceResponse(response, metadata, 100).catch(error => error);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls) + error.message).not.toContain("fixture-stream-secret");
  });
  it("bounds stalled response bodies", async () => {
    vi.useFakeTimers();
    const response = new Response();
    vi.spyOn(response, "text").mockReturnValue(new Promise(() => {}));
    const pending = expect(readMarketplaceResponse(response, metadata, 10)).rejects.toThrow("response body timed out");
    await vi.advanceTimersByTimeAsync(10);
    await pending;
  });
});
