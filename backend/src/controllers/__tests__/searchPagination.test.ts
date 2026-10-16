import { beforeEach, describe, expect, it, vi } from "vitest";
import { searchAll } from "../searchController";
import { searchEbayPage } from "../../services/ebayService";
import { searchMarketplaceNormalized } from "../../services/marketplaceService";
import type { Listing } from "../../types/listing";
vi.mock("../../services/ebayService", () => ({ searchEbayPage: vi.fn() }));
vi.mock("../../services/marketplaceService", () => ({ searchMarketplaceNormalized: vi.fn() }));
vi.mock("../../services/scoring/scoreListing", () => ({ scoreListings: vi.fn() }));
vi.mock("../../ai/listingContext", () => ({ fetchMarketContext: vi.fn() }));
vi.mock("../../utils/geoIp", () => ({ getLocationFromIp: vi.fn(async () => null), extractClientIp: vi.fn(), getMarketplaceSearchLocation: vi.fn(() => ({ location: "10001" })) }));
vi.mock("../../services/listingAnalysisProof", () => ({ signListingForAnalysis: (l: unknown) => l }));
async function search(query: Record<string, string> = {}) {
  const res = { setHeader: vi.fn(), json: vi.fn(), status: vi.fn() };
  await searchAll({ query: { query: "nintendo", limit: "12", ...query } } as any, res as any);
  return res;
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(searchEbayPage).mockReset();
  vi.mocked(searchMarketplaceNormalized).mockReset();
  vi.mocked(searchMarketplaceNormalized).mockResolvedValue([{ source: "marketplace", id: "m1", price: 20 }] as any);
  vi.mocked(searchEbayPage).mockResolvedValue({ items: [], hasMore: true, nextOffset: 250, unavailable: false, remainingWindows: 0 });
});
const ebayItems = (start: number, count: number): Listing[] => Array.from({ length: count }, (_, i) => ({
  source: "ebay", id: `e${start + i}`, title: "Nintendo", price: 20, url: "https://www.ebay.com/itm/1", images: [],
}));
describe("aggregate pagination contract", () => {
  it("keeps Marketplace rows out of the eBay cursor after a filtered scan budget", async () => {
    const res = await search();
    expect(searchEbayPage).toHaveBeenCalledExactlyOnceWith("nintendo", 6, null, undefined, undefined, undefined, 0);
    expect(res.setHeader).toHaveBeenCalledWith("X-Search-Has-More", "true");
    expect(res.setHeader).toHaveBeenCalledWith("X-Search-Next-Offset", "250");
    expect(res.json).toHaveBeenCalledWith([expect.objectContaining({ id: "m1" })]);
  });
  it("only fetches eBay on subsequent pages", async () => {
    await search({ offset: "250" });
    expect(searchMarketplaceNormalized).not.toHaveBeenCalled();
    expect(searchEbayPage).toHaveBeenCalledWith("nintendo", 12, null, undefined, undefined, undefined, 250);
  });
  it("starts eBay while the initial Marketplace request is still pending", async () => {
    let release!: (items: Listing[]) => void;
    vi.mocked(searchMarketplaceNormalized).mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    const pending = search();
    await vi.waitFor(() => expect(searchEbayPage).toHaveBeenCalledTimes(1));
    release([]);
    await pending;
  });
  it("refills missing Marketplace slots from the raw cursor within the remaining scan budget", async () => {
    vi.mocked(searchEbayPage)
      .mockResolvedValueOnce({ items: ebayItems(60, 6), hasMore: true, nextOffset: 72, unavailable: false, remainingWindows: 4 })
      .mockResolvedValueOnce({ items: ebayItems(72, 5), hasMore: true, nextOffset: 77, unavailable: false, remainingWindows: 3 });
    const res = await search();
    expect(searchEbayPage).toHaveBeenNthCalledWith(2, "nintendo", 5, null, undefined, undefined, undefined, 72, 4);
    expect(res.setHeader).toHaveBeenCalledWith("X-Search-Next-Offset", "77");
    const items = res.json.mock.calls[0][0] as Listing[];
    expect(items).toHaveLength(12);
    expect(new Set(items.map(item => `${item.source}:${item.id}`)).size).toBe(12);
  });
  it("preserves the initial rows and retry cursor when a refill fails", async () => {
    vi.mocked(searchEbayPage)
      .mockResolvedValueOnce({ items: ebayItems(60, 6), hasMore: true, nextOffset: 72, unavailable: false, remainingWindows: 4 })
      .mockResolvedValueOnce({ items: [], hasMore: true, nextOffset: 72, unavailable: true, remainingWindows: 3 });
    const res = await search();
    expect(res.json.mock.calls[0][0]).toHaveLength(7);
    expect(res.setHeader).toHaveBeenCalledWith("X-Search-Next-Offset", "72");
    expect(res.setHeader).toHaveBeenCalledWith("X-Ebay-Search-Status", "unavailable");
  });
  it("skips Marketplace and reserves the full batch for eBay on zero-cursor retries", async () => {
    await search({ offset: "0", continuation: "1" });
    expect(searchMarketplaceNormalized).not.toHaveBeenCalled();
    expect(searchEbayPage).toHaveBeenCalledExactlyOnceWith("nintendo", 12, null, undefined, undefined, undefined, 0);
  });
  it("ends Marketplace-only searches even when the batch is full", async () => {
    const res = await search({ sources: "marketplace" });
    expect(searchEbayPage).not.toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith("X-Search-Has-More", "false");
  });
  it("reports source failure separately from exhaustion", async () => {
    vi.mocked(searchEbayPage).mockResolvedValue({ items: [], hasMore: true, nextOffset: 0, unavailable: true, remainingWindows: 4 });
    const res = await search();
    expect(res.setHeader).toHaveBeenCalledWith("X-Ebay-Search-Status", "unavailable");
    expect(res.setHeader).toHaveBeenCalledWith("X-Search-Has-More", "true");
    expect(searchEbayPage).toHaveBeenCalledTimes(1);
  });
});
