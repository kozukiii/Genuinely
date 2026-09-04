import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchVisionImage } from "../fetchVisionImage";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const image = () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg" } });

describe("vision image downloads", () => {
  it("does not retry a failed download", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error("timeout")).mockResolvedValueOnce(image());
    vi.stubGlobal("fetch", fetchMock);
    const pending = fetchVisionImage("https://example.test/image.jpg");
    await vi.runAllTimersAsync();
    expect(await pending).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("limits concurrent downloads across listings to eight", async () => {
    let active = 0;
    let peak = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return image();
    }));
    const results = await Promise.all(Array.from({ length: 30 }, () => fetchVisionImage("https://example.test/image.jpg")));
    expect(peak).toBeLessThanOrEqual(8);
    expect(results.every(Boolean)).toBe(true);
  });
  it("does not retry permanent missing images", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("missing", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchVisionImage("https://example.test/missing.jpg")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
