import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ build: vi.fn(), run: vi.fn(), score: vi.fn() }));
vi.mock("../ebayOverview", () => ({ buildEbayAnalysisMessages: mocks.build }));
vi.mock("../marketplaceOverview", () => ({ buildMarketplaceAnalysisMessages: mocks.build }));
vi.mock("../groqBatchRun", () => ({ runRawChatRequests: mocks.run }));
vi.mock("../../services/aiService", () => ({ scoreEbayItemFromRaw: mocks.score }));
vi.mock("../../services/scoring/scoreMarketplaceListing", () => ({ scoreMarketplaceListingFromRaw: mocks.score }));
import { scoreGroupsViaChat } from "../../services/scoring/scoreGroupsBatch";

describe("cross-listing failure isolation", () => {
  it("preserves ordering and never fabricates scores for image or generation failures", async () => {
    mocks.build.mockImplementation(async (listing) => {
      if (listing.id === "missing-image") throw new Error("Failed to fetch 1 of 9 eBay images");
      return [{ role: "system", content: "score" }];
    });
    mocks.run.mockResolvedValue(["valid-analysis", ""]);
    mocks.score.mockImplementation((listing) => ({ ...listing, aiScore: 90 }));
    const listings = ["missing-image", "good", "invalid-json"].map((id) => ({ id, source: "ebay" }));
    const result = await scoreGroupsViaChat([{ listings }]);
    expect(result.map((row) => row.id)).toEqual(listings.map((row) => row.id));
    expect(result.map((row) => row.aiScore)).toEqual([null, 90, null]);
    expect(mocks.score).toHaveBeenCalledTimes(1);
    expect(mocks.run.mock.calls[0][0]).toHaveLength(2);
    expect(mocks.run.mock.calls[0][2].allowPartial).toBe(true);
  });
});
