import { beforeEach, describe, expect, it, vi } from "vitest";
import fetch, { Response } from "node-fetch";
import { searchEbayPage } from "../ebayService";
vi.mock("node-fetch", async (original) => ({ ...await original<typeof import("node-fetch")>(), default: vi.fn() }));
vi.mock("../ebayToken", () => ({ getEbayToken: vi.fn(async () => "test") }));
const json = (body: unknown) => new Response(JSON.stringify(body));
const summary = (id: number, variation = false) => ({
  itemId: `v1|${id}|${variation ? 1 : 0}`, title: "Nintendo", itemWebUrl: `https://www.ebay.com/itm/${id}`,
  price: { value: "20", currency: "USD" },
});
function source(rows: ReturnType<typeof summary>[], detail: (id: string) => object = () => ({})) {
  vi.mocked(fetch).mockImplementation(async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith("/search")) {
      const start = Number(parsed.searchParams.get("offset") ?? 0);
      const limit = Number(parsed.searchParams.get("limit"));
      expect(start % limit).toBe(0);
      return json({ itemSummaries: rows.slice(start, start + limit), total: rows.length });
    }
    return json(detail(parsed.pathname.split("/").pop()!));
  });
}
beforeEach(() => { vi.mocked(fetch).mockReset(); });
describe("raw eBay pagination", () => {
  it("fills a fresh nintendo search after a whole window of excluded variations", async () => {
    source(Array.from({ length: 90 }, (_, i) => summary(i, i < 60)));
    const first = await searchEbayPage("nintendo", 12);
    expect(first.items).toHaveLength(12);
    expect(first).toMatchObject({ nextOffset: 72, hasMore: true, unavailable: false });
    const second = await searchEbayPage("nintendo", 12, null, undefined, undefined, undefined, first.nextOffset);
    expect(second.items.map(i => i.id)).toEqual(Array.from({ length: 12 }, (_, i) => `v1|${i + 72}|0`));
    expect(second.nextOffset).toBe(84);
    expect(new Set([...first.items, ...second.items].map(i => i.id)).size).toBe(24);
  });
  it("resumes within a fixed window even when the requested size changes", async () => {
    source(Array.from({ length: 90 }, (_, i) => summary(i)));
    const first = await searchEbayPage("nintendo", 6);
    const second = await searchEbayPage("nintendo", 12, null, undefined, undefined, undefined, first.nextOffset);
    expect(first.nextOffset).toBe(6);
    expect(second.nextOffset).toBe(18);
    expect(second.items[0].id).toBe("v1|6|0");
  });
  it("keeps a fully filtered scan budget resumable, then finds the later item", async () => {
    source(Array.from({ length: 251 }, (_, i) => summary(i, i < 250)));
    const first = await searchEbayPage("nintendo", 12);
    expect(first).toMatchObject({ items: [], nextOffset: 250, hasMore: true, unavailable: false });
    const last = await searchEbayPage("nintendo", 12, null, undefined, undefined, undefined, 250);
    expect(last.items).toHaveLength(1);
    expect(last).toMatchObject({ nextOffset: 251, hasMore: false });
  });
  it("refills detail-only variations and invalid listings, without counting them as exhaustion", async () => {
    const rows = Array.from({ length: 25 }, (_, i) => summary(i));
    rows[1].title = "";
    source(rows, id => id === "v1|0|0" ? { itemGroupType: "SELLER_DEFINED_VARIATIONS" } : {});
    const page = await searchEbayPage("nintendo", 12);
    expect(page.items).toHaveLength(12);
    expect(page.nextOffset).toBe(14);
    expect(page.hasMore).toBe(true);
  });
  it("does not request beyond the upstream 10000-result limit", async () => {
    source(Array.from({ length: 10020 }, (_, i) => summary(i)));
    const page = await searchEbayPage("nintendo", 12, null, undefined, undefined, undefined, 9995);
    expect(page).toMatchObject({ nextOffset: 10000, hasMore: false });
    expect(page.items).toHaveLength(5);
  });
  it("distinguishes HTTP failures from genuine empty results and keeps the retry cursor", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("Unavailable", { status: 503 }));
    expect(await searchEbayPage("nintendo", 12)).toMatchObject({ items: [], nextOffset: 0, hasMore: true, unavailable: true });
    source([]);
    expect(await searchEbayPage("nintendo", 12)).toMatchObject({ items: [], nextOffset: 0, hasMore: false, unavailable: false });
  });
  it("preserves partial progress if the following window fails", async () => {
    source(Array.from({ length: 100 }, (_, i) => summary(i, i < 45)));
    const fetchSource = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((url, init) => String(url).includes("offset=50")
      ? Promise.resolve(new Response("Unavailable", { status: 503 })) : fetchSource(url, init));
    expect(await searchEbayPage("nintendo", 12)).toMatchObject({ nextOffset: 50, hasMore: true, unavailable: true });
  });
});

describe("upstream protocol safeguards", () => {
  it("treats malformed and repeated upstream windows as failures, not exhaustion", async () => {
    for (const response of [{}, { errors: [{ errorId: 1 }] }, { offset: 0, total: 100, itemSummaries: [summary(1)] }]) {
      vi.mocked(fetch).mockResolvedValue(json(response));
      expect(await searchEbayPage("nintendo", 12, null, undefined, undefined, undefined, 50))
        .toMatchObject({ hasMore: true, nextOffset: 50, unavailable: true });
    }
  });
});
