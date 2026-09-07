import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fetch, { Response } from "node-fetch";
import express from "express";
import { once } from "events";
import imageRouter from "../../routes/imageProxyRoutes";
import { getSourceImage, SourceImageCache } from "../../services/sourceImageCache";
import { fetchVisionImage } from "../fetchVisionImage";

vi.mock("node-fetch", async (importOriginal) => ({
  ...await importOriginal<typeof import("node-fetch")>(), default: vi.fn(),
}));
vi.mock("dns/promises", () => ({ default: { lookup: vi.fn(async () => [{ address: "8.8.8.8" }]) } }));
const fetchMock = vi.mocked(fetch);
beforeEach(() => fetchMock.mockReset());
afterEach(() => vi.useRealTimers());
const image = () => new Response(Buffer.from([1, 2, 3]), { headers: { "content-type": "image/jpeg" } });

describe("vision image downloads", () => {
  it("does not retry a failed download", async () => {
    fetchMock.mockRejectedValueOnce(new Error("timeout")).mockResolvedValueOnce(image());
    const pending = fetchVisionImage("https://example.test/image.jpg");
    expect(await pending).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await fetchVisionImage("https://example.test/image.jpg")).toEqual(Buffer.from([1, 2, 3]));
  });
  it("limits concurrent downloads across listings to eight", async () => {
    let active = 0;
    let peak = 0;
    fetchMock.mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return image();
    });
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => fetchVisionImage(`https://example.test/concurrent-${i}.jpg`)));
    expect(peak).toBe(8);
    expect(results.every(Boolean)).toBe(true);
  });
  it("does not retry permanent missing images", async () => {
    fetchMock.mockResolvedValue(new Response("missing", { status: 404 }));
    expect(await fetchVisionImage("https://example.test/missing.jpg")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("shared backend image delivery", () => {
  it("shares in-flight downloads and original bytes between display and stitching", async () => {
    fetchMock.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return image();
    });
    const url = "https://i.ebayimg.com/images/g/shared/s-l1600.jpg";
    const [display, vision] = await Promise.all([getSourceImage(url), fetchVisionImage(url)]);
    expect(vision).toBe(display.buffer);
    const app = express().use("/api/proxy-image", imageRouter);
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address() as { port: number };
      const response = await globalThis.fetch(`http://127.0.0.1:${address.port}/api/proxy-image?url=${encodeURIComponent(url)}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("image/jpeg");
      expect(response.headers.get("cache-control")).toBe("public, max-age=300");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(vision);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe(url);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
  it("rejects private addresses, including redirect destinations", async () => {
    expect(await fetchVisionImage("http://127.0.0.1/private.jpg")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValue(new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private.jpg" } }));
    expect(await fetchVisionImage("https://example.test/redirect.jpg")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("rejects non-images and empty images", async () => {
    fetchMock.mockResolvedValueOnce(new Response("html", { headers: { "content-type": "text/html" } })).mockResolvedValueOnce(new Response(null, { headers: { "content-type": "image/jpeg" } }));
    expect(await fetchVisionImage("https://example.test/html.jpg")).toBeNull();
    expect(await fetchVisionImage("https://example.test/empty.jpg")).toBeNull();
  });
});

describe("temporary image cache", () => {
  const download = () => ({ buffer: Buffer.from([1, 2, 3]), contentType: "image/jpeg" });
  it("expires original bytes after its TTL", async () => {
    vi.useFakeTimers();
    const cache = new SourceImageCache(32, 100);
    const loader = vi.fn(async () => download());
    await cache.get("ttl", loader);
    await cache.get("ttl", loader);
    expect(loader).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(101);
    await cache.get("ttl", loader);
    expect(loader).toHaveBeenCalledTimes(2);
  });
  it("evicts least-recently-used bytes to stay within the memory limit", async () => {
    const cache = new SourceImageCache(6);
    const loader = vi.fn(async () => download());
    for (const key of ["a", "b", "a", "c", "a"]) await cache.get(key, loader);
    expect(loader).toHaveBeenCalledTimes(3);
    await cache.get("b", loader);
    expect(loader).toHaveBeenCalledTimes(4);
  });
  it("bounds entry count and does not retain oversized entries", async () => {
    const cache = new SourceImageCache(8, 1000, 1);
    const loader = vi.fn(async () => download());
    for (const key of ["a", "b", "a"]) await cache.get(key, loader);
    expect(loader).toHaveBeenCalledTimes(3);
    const big = vi.fn(async () => ({ buffer: Buffer.alloc(9), contentType: "image/jpeg" }));
    await cache.get("big", big);
    await cache.get("big", big);
    expect(big).toHaveBeenCalledTimes(2);
  });
});
