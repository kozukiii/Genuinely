import { beforeEach, describe, expect, it, vi } from "vitest";
import fetch, { Response } from "node-fetch";
import { searchEbayNormalized } from "../ebayService";

vi.mock("node-fetch", async (importOriginal) => ({
  ...await importOriginal<typeof import("node-fetch")>(), default: vi.fn(),
}));
vi.mock("../ebayToken", () => ({ getEbayToken: vi.fn(async () => "test-token") }));
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const thumbnail = "https://i.ebayimg.com/example/s-l225.jpg";
beforeEach(() => vi.mocked(fetch).mockReset());
describe("eBay API photo URLs", () => {
  for (const detailed of [true, false]) {
    it(detailed ? "uses item-detail photos without rewriting URLs" : "keeps API thumbnails when details contain no photos", async () => {
      const photos = ["https://i.ebayimg.com/example/s-l1600.jpg", "https://i.ebayimg.com/second/s-l1600.jpg"];
      vi.mocked(fetch).mockResolvedValueOnce(json({ itemSummaries: [{
        itemId: "v1|123456789|0", title: "Headphones", itemWebUrl: "https://www.ebay.com/itm/123456789",
        image: { imageUrl: thumbnail }, price: { value: "100", currency: "USD" },
      }] })).mockResolvedValueOnce(json(detailed ? {
        image: { imageUrl: photos[0] }, additionalImages: [{ imageUrl: photos[1] }],
      } : {}));
      const listings = await searchEbayNormalized("headphones", 1);
      expect(listings).toHaveLength(1);
      expect(listings[0].images).toEqual(detailed ? photos : [thumbnail]);
    });
  }
});
