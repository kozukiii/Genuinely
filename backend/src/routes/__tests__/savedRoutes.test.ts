import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import { once } from "events";
import type { Server } from "http";
import router from "../savedRoutes";
import { getEbayItemByEbayId } from "../../services/ebayService";
import db from "../../db";

vi.mock("../../db", () => ({ default: { prepare: vi.fn(() => ({ run: vi.fn() })) } }));
vi.mock("../../middleware/auth", () => ({
  requireAuth: (req: any, _res: any, next: () => void) => { req.user = { id: "test" }; next(); },
}));
vi.mock("../../services/ebayService", () => ({ getEbayItemByEbayId: vi.fn(async (id) => ({
  id, source: "ebay", title: "Live source title", images: ["https://i.ebayimg.com/live/s-l1600.jpg"],
})) }));
vi.mock("../../services/marketplaceService", () => ({ getMarketplaceListingByGraphqlForAnalysis: vi.fn() }));

let server: Server;
let base: string;
beforeAll(async () => {
  server = express().use(express.json()).use("/saved", router).listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/saved`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
const post = (path: string, body: unknown) => fetch(base + path, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

describe("saved listing image initialization", () => {
  it("gets live image URLs via the API without losing a saved variant ID", async () => {
    const response = await post("/hydrate", { items: [{ source: "ebay", id: "v1|123456789|987654321" }] });
    expect(response.status).toBe(200);
    expect(getEbayItemByEbayId).toHaveBeenCalledWith("v1|123456789|987654321", null);
    expect((await response.json()).listings[0].images).toEqual(["https://i.ebayimg.com/live/s-l1600.jpg"]);
  });
  it("does not persist source content or image URLs in saved records", async () => {
    const response = await post("", { listing: {
      id: "v1|123456789|0", source: "ebay", aiScore: 90,
      images: ["https://i.ebayimg.com/photo.jpg"], imageUrls: ["https://i.ebayimg.com/photo.jpg"],
      title: "Source title", description: "Original text", price: 100,
    } });
    expect(response.status).toBe(200);
    const statement = vi.mocked(db.prepare).mock.results.at(-1)!.value;
    const stored = JSON.parse(statement.run.mock.calls[0][3]);
    expect(stored).toEqual({ id: "v1|123456789|0", source: "ebay", aiScore: 90 });
  });
});
