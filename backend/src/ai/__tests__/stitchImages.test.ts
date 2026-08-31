import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  MAX_IMAGE_BLOCKS,
  MAX_SOURCE_IMAGES,
  planImageBlocks,
  stitchBufferBlocks,
  stitchBuffers,
} from "../stitchImages";

describe("image stitching capacity", () => {
  it("uses at most nine photos per grid and three grids per listing", () => {
    expect(MAX_IMAGE_BLOCKS).toBe(3);
    expect(MAX_SOURCE_IMAGES).toBe(27);
    expect(planImageBlocks(0)).toEqual([]);
    expect(planImageBlocks(9).map((group) => group.length)).toEqual([9]);
    expect(planImageBlocks(10).map((group) => group.length)).toEqual([9, 1]);
    expect(planImageBlocks(27).map((group) => group.length)).toEqual([9, 9, 9]);
  });

  it("rejects a 28th photo instead of truncating it", () => {
    expect(() => planImageBlocks(28)).toThrow(/capacity is 27/);
  });

  it("stitches all 27 source photos across three complete grids", async () => {
    const source = await sharp({
      create: { width: 8, height: 8, channels: 3, background: "red" },
    }).png().toBuffer();

    const grids = await stitchBufferBlocks(Array.from({ length: 27 }, () => source));

    expect(grids).toHaveLength(3);
    expect(grids.map((grid) => grid.cellCount)).toEqual([9, 9, 9]);
    expect(grids.reduce((sum, grid) => sum + grid.cellCount, 0)).toBe(27);
  });

  it("rejects an oversized single grid instead of slicing it", async () => {
    const source = await sharp({
      create: { width: 8, height: 8, channels: 3, background: "blue" },
    }).png().toBuffer();

    await expect(stitchBuffers(Array.from({ length: 10 }, () => source))).rejects.toThrow(/one 9-cell grid/);
  });
});
