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
  it("stops after a direct access denial without trying a proxy", async () => {
    const { searchMarketplaceNormalized } = await import("../marketplaceService");
    vi.mocked(fetch).mockResolvedValue(new Response("unauthorized", { status: 401 }));
    await expect(searchMarketplaceNormalized(searchOptions)).rejects.toMatchObject({ accessDenied: true });
    await expect(searchMarketplaceNormalized(searchOptions)).rejects.toMatchObject({ accessDenied: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(diagnostics()).toContainEqual(expect.objectContaining({ route: "direct", phase: "initial", status: 401, configuredProxyCount: 1 }));
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
  it("attributes a proxy denial and cancels further race candidates", async () => {
    vi.useFakeTimers();
    const { searchMarketplaceNormalized } = await import("../marketplaceService");
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response("temporary upstream failure", { status: 502 }))
      .mockResolvedValueOnce(new Response("unauthorized", { status: 407, headers: { "content-type": "text/plain", "proxy-authenticate": "Basic" } }));
    await expect(searchMarketplaceNormalized(searchOptions)).rejects.toMatchObject({ accessDenied: true });
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(diagnostics()).toContainEqual(expect.objectContaining({ route: "proxy", phase: "fallback", status: 407, proxyIndex: 1, proxyAuthorizationConfigured: true }));
    const messages = JSON.stringify([...vi.mocked(console.info).mock.calls, ...vi.mocked(console.log).mock.calls, ...vi.mocked(console.warn).mock.calls]);
    expect(messages).not.toMatch(/fixture-user|fixture-password|proxy\.test|temporary upstream failure/);
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
  });
});
