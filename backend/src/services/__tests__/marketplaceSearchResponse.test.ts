import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fetch, { Response } from "node-fetch";
vi.mock("node-fetch", async original => ({ ...await original<typeof import("node-fetch")>(), default: vi.fn() }));
beforeEach(() => {
  vi.resetModules();
  vi.mocked(fetch).mockReset();
  vi.stubEnv("PROXY_URL", "http://fixture-user:fixture-password@proxy.test:8123");
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers(); });
const searchOptions = { query: "golf clubs", lat: 44.8, lng: -91.5, enrichImages: false, limit: 2 };
const diagnostics = () => vi.mocked(console.info).mock.calls
  .filter(([prefix]) => prefix === "[marketplace:response]")
  .map(([, message]) => JSON.parse(String(message)));

describe("Marketplace browse response handling", () => {
  it("uses direct egress only when no proxy is configured and stops after denial", async () => {
    vi.stubEnv("PROXY_URL", "");
    const { searchMarketplaceNormalized } = await import("../marketplaceService");
    vi.mocked(fetch).mockResolvedValue(new Response("unauthorized", { status: 401 }));
    await expect(searchMarketplaceNormalized(searchOptions)).rejects.toMatchObject({ accessDenied: true });
    await expect(searchMarketplaceNormalized(searchOptions)).rejects.toMatchObject({ accessDenied: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls[0][1]?.agent).toBeUndefined();
    expect(diagnostics()).toContainEqual(expect.objectContaining({ route: "direct", phase: "initial", status: 401, configuredProxyCount: 0 }));
  });
  it("backs off after GraphQL rate limiting without re-racing or calling upstream during the cooldown", async () => {
    vi.useFakeTimers();
    const { searchMarketplaceNormalized } = await import("../marketplaceService");
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ errors: [{ code: 1675004 }] }), { headers: { "retry-after": "2" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { marketplace_search: { feed_units: { edges: [] } } } })));
    await expect(searchMarketplaceNormalized(searchOptions)).rejects.toMatchObject({ accessDenied: true, retryAfterMs: 2000 });
    await expect(searchMarketplaceNormalized(searchOptions)).rejects.toThrow("backing off");
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2001);
    await expect(searchMarketplaceNormalized(searchOptions)).resolves.toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("uses the configured proxy initially and never reroutes a proxy denial", async () => {
    vi.useFakeTimers();
    vi.stubEnv("PROXY_URL", "http://fixture-user:fixture-password@proxy.test:8123,http://other.test:8123");
    const { searchMarketplaceNormalized } = await import("../marketplaceService");
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response("unauthorized", { status: 407, headers: { "content-type": "text/plain", "proxy-authenticate": "Basic" } }));
    await expect(searchMarketplaceNormalized(searchOptions)).rejects.toMatchObject({ accessDenied: true });
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls[0][1]?.agent).toBeDefined();
    expect(diagnostics()).toContainEqual(expect.objectContaining({ route: "proxy", phase: "initial", status: 407, proxyIndex: 1, proxyAuthorizationConfigured: true }));
    const messages = JSON.stringify([...vi.mocked(console.info).mock.calls, ...vi.mocked(console.log).mock.calls, ...vi.mocked(console.warn).mock.calls]);
    expect(messages).not.toMatch(/fixture-user|fixture-password|proxy\.test|other\.test/);
  });
  it("rejects malformed proxy configuration without sending a direct request", async () => {
    vi.stubEnv("PROXY_URL", "proxy.test:8123:fixture-user:fixture-password");
    const { searchMarketplaceNormalized } = await import("../marketplaceService");
    await expect(searchMarketplaceNormalized(searchOptions)).rejects.toThrow("valid HTTP(S) URL");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not switch routes or expose transport exception details", async () => {
    const { searchMarketplaceNormalized } = await import("../marketplaceService");
    vi.mocked(fetch).mockRejectedValueOnce(new Error("fixture-transport-secret"));
    await expect(searchMarketplaceNormalized(searchOptions)).rejects.toThrow("transport failed");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain("fixture-transport-secret");
  });
  it("shares search cooldowns with listing details without sending more requests", async () => {
    const { searchMarketplaceNormalized, getMarketplaceListingFull } = await import("../marketplaceService");
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ errors: [{ code: 1675004 }] })));
    await expect(searchMarketplaceNormalized(searchOptions)).rejects.toMatchObject({ accessDenied: true });
    await expect(getMarketplaceListingFull("123456789")).rejects.toThrow("unavailable");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("uses the proxy for detail queries and never retries a detail authentication denial", async () => {
    const { searchMarketplaceNormalized, getMarketplaceListingFull } = await import("../marketplaceService");
    vi.mocked(fetch).mockImplementation(async () => new Response("unauthorized", { status: 407 }));
    await expect(getMarketplaceListingFull("123456789")).rejects.toThrow("unavailable");
    await expect(searchMarketplaceNormalized(searchOptions)).rejects.toThrow("backing off");
    // Container and gallery requests were already in flight together.
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch).mock.calls.every(([, options]) => Boolean(options?.agent))).toBe(true);
    expect(diagnostics()).toContainEqual(expect.objectContaining({ route: "proxy", status: 407, proxyIndex: 1 }));
  });
  it("keeps the longest cooldown and its reason when in-flight requests fail concurrently", async () => {
    vi.useFakeTimers();
    const { searchMarketplaceNormalized } = await import("../marketplaceService");
    let firstResponse!: (response: Response) => void;
    let secondResponse!: (response: Response) => void;
    vi.mocked(fetch)
      .mockReturnValueOnce(new Promise(resolve => { firstResponse = resolve; }))
      .mockReturnValueOnce(new Promise(resolve => { secondResponse = resolve; }));
    const first = searchMarketplaceNormalized(searchOptions).catch(error => error);
    const second = searchMarketplaceNormalized(searchOptions).catch(error => error);
    firstResponse(new Response(null, { status: 429, headers: { "retry-after": "120" } }));
    await first;
    secondResponse(new Response(null, { status: 401 }));
    await second;
    await vi.advanceTimersByTimeAsync(60_001);
    await expect(searchMarketplaceNormalized(searchOptions)).rejects.toThrow("backing off");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(vi.mocked(console.warn).mock.calls.at(-1)?.[1]))).toMatchObject({ reason: "rate-limited", retryAfterSeconds: 60 });
    await vi.advanceTimersByTimeAsync(60_000);
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ data: { marketplace_search: { feed_units: { edges: [] } } } })));
    await expect(searchMarketplaceNormalized(searchOptions)).resolves.toEqual([]);
  });
  it("preserves real listing data and the normal View on Marketplace destination", async () => {
    const { searchMarketplaceNormalized } = await import("../marketplaceService");
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ data: { marketplace_search: { feed_units: { edges: [
      { node: { listing: { id: "123456789", marketplace_listing_title: "Golf clubs", listing_price: { amount: "25" }, location: { latitude: 44.8, longitude: -91.5 } } } },
    ] } } } }), { headers: { "content-type": "application/json" } }));
    const listings = await searchMarketplaceNormalized(searchOptions);
    expect(listings).toEqual([expect.objectContaining({ source: "marketplace", title: "Golf clubs", price: 25, url: "https://www.facebook.com/marketplace/item/123456789" })]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls[0][1]?.agent).toBeDefined();
    expect(diagnostics()).toContainEqual(expect.objectContaining({ route: "proxy", phase: "initial", outcome: "json" }));
  });
});
