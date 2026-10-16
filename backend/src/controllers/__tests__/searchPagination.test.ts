import { beforeEach, describe, expect, it, vi } from "vitest";
import { searchAll } from "../searchController";
import { searchEbayPage } from "../../services/ebayService";
import { searchMarketplaceNormalized } from "../../services/marketplaceService";
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
  vi.mocked(searchMarketplaceNormalized).mockResolvedValue([{ source: "marketplace", id: "m1", price: 20 }] as any);
  vi.mocked(searchEbayPage).mockResolvedValue({ items: [], hasMore: true, nextOffset: 250, unavailable: false });
});
describe("aggregate pagination contract", () => {
  it("fills around Marketplace without including its rows in the eBay cursor", async () => {
    const res = await search();
    expect(searchEbayPage).toHaveBeenCalledWith("nintendo", 11, null, undefined, undefined, undefined, 0);
    expect(res.setHeader).toHaveBeenCalledWith("X-Search-Has-More", "true");
    expect(res.setHeader).toHaveBeenCalledWith("X-Search-Next-Offset", "250");
    expect(res.json).toHaveBeenCalledWith([expect.objectContaining({ id: "m1" })]);
  });
  it("only fetches eBay on subsequent pages", async () => {
    await search({ offset: "250" });
    expect(searchMarketplaceNormalized).not.toHaveBeenCalled();
    expect(searchEbayPage).toHaveBeenCalledWith("nintendo", 12, null, undefined, undefined, undefined, 250);
  });
  it("ends Marketplace-only searches even when the batch is full", async () => {
    const res = await search({ sources: "marketplace" });
    expect(searchEbayPage).not.toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith("X-Search-Has-More", "false");
  });
  it("reports source failure separately from exhaustion", async () => {
    vi.mocked(searchEbayPage).mockResolvedValue({ items: [], hasMore: true, nextOffset: 0, unavailable: true });
    const res = await search();
    expect(res.setHeader).toHaveBeenCalledWith("X-Ebay-Search-Status", "unavailable");
    expect(res.setHeader).toHaveBeenCalledWith("X-Search-Has-More", "true");
  });
});
