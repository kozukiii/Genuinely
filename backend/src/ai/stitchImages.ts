import sharp from "sharp";

// ─── Image grid stitching ──────────────────────────────────────────────────
//
// Vision models (llama-4-scout on Groq) tile + downscale every image they
// receive, and cap the number of image blocks per request. Sending a listing's
// photos one-by-one burns that cap fast — often only one listing fits per call.
//
// Stitching a listing's photos into a single padded grid collapses N images to
// 1, so several listings fit in one call. The tradeoff is per-photo resolution:
// each cell gets a fraction of the model's tiling budget. We cap at a 2×2 grid
// (4 photos) and keep cells large to preserve enough detail for condition
// inspection (scratches, wear, print lines).

export const MAX_CELLS = 4;  // 2×2 — past this, per-cell detail degrades too far
const CELL_PX = 1024;         // each cell is CELL_PX × CELL_PX (2048² grid ≈ 4.2MP, well under Groq's limit)
const BG = { r: 255, g: 255, b: 255, alpha: 1 };

// Groq caps a request at 5 image blocks. Distribute a listing's photos across up
// to `maxBlocks` blocks, preferring raw single-photo blocks (best detail) and
// only grouping into stitched grids once there are more photos than blocks — so
// no photo is dropped. Returns index groups; a group of 1 = raw, >1 = stitched.
// Capacity is maxBlocks × maxCells photos; anything beyond that is truncated.
export function planImageBlocks(count: number, maxBlocks = 5, maxCells = MAX_CELLS): number[][] {
  const n = Math.min(count, maxBlocks * maxCells);
  if (n <= 0) return [];
  if (n <= maxBlocks) return Array.from({ length: n }, (_, i) => [i]);

  const base = Math.floor(n / maxBlocks);
  const extra = n % maxBlocks;
  const blocks: number[][] = [];
  let idx = 0;
  for (let b = 0; b < maxBlocks; b++) {
    const size = base + (b < extra ? 1 : 0);
    const group: number[] = [];
    for (let k = 0; k < size; k++) group.push(idx++);
    blocks.push(group);
  }
  return blocks;
}

export interface StitchResult {
  /** data: URL of the composite JPEG */
  dataUrl: string;
  /** number of source photos placed into the grid */
  cellCount: number;
  /** grid dimensions */
  cols: number;
  rows: number;
}

function gridDims(n: number): { cols: number; rows: number } {
  if (n <= 1) return { cols: 1, rows: 1 };
  if (n === 2) return { cols: 2, rows: 1 };
  return { cols: 2, rows: 2 }; // 3 or 4
}

/**
 * Stitch up to MAX_CELLS image buffers into a single padded grid JPEG.
 * Returns null if no buffer could be decoded.
 */
export async function stitchBuffers(buffers: Buffer[]): Promise<StitchResult | null> {
  const usable = buffers.slice(0, MAX_CELLS);
  if (usable.length === 0) return null;

  // Resize each source into a square CELL_PX cell, letterboxed on white so
  // aspect ratio is preserved (no stretching that would distort defects).
  const cells = await Promise.all(
    usable.map(async (buf) => {
      try {
        return await sharp(buf)
          .resize(CELL_PX, CELL_PX, { fit: "contain", background: BG })
          .toBuffer();
      } catch {
        return null;
      }
    })
  );

  const valid = cells.filter((c): c is Buffer => c !== null);
  if (valid.length === 0) return null;

  const { cols, rows } = gridDims(valid.length);
  const composite = valid.map((input, i) => ({
    input,
    left: (i % cols) * CELL_PX,
    top: Math.floor(i / cols) * CELL_PX,
  }));

  const canvas = sharp({
    create: {
      width: cols * CELL_PX,
      height: rows * CELL_PX,
      channels: 3,
      background: BG,
    },
  });

  const jpeg = await canvas.composite(composite).jpeg({ quality: 82 }).toBuffer();
  return {
    dataUrl: `data:image/jpeg;base64,${jpeg.toString("base64")}`,
    cellCount: valid.length,
    cols,
    rows,
  };
}

/** Strip a `data:...;base64,` prefix and decode to a Buffer. Returns null on malformed input. */
export function dataUrlToBuffer(dataUrl: string): Buffer | null {
  const comma = dataUrl.indexOf(",");
  if (comma === -1 || !/;base64/i.test(dataUrl.slice(0, comma))) return null;
  try {
    return Buffer.from(dataUrl.slice(comma + 1), "base64");
  } catch {
    return null;
  }
}

/** Stitch from an array of data URLs (marketplace path — images already fetched). */
export async function stitchDataUrls(dataUrls: string[]): Promise<StitchResult | null> {
  const buffers = dataUrls.map(dataUrlToBuffer).filter((b): b is Buffer => b !== null);
  return stitchBuffers(buffers);
}

/**
 * Human-readable description of the grid layout, injected into the prompt so the
 * model knows the single image is a composite of separate photos, not one odd shot.
 */
export function gridLayoutNote(cols: number, rows: number, cellCount: number): string {
  if (cellCount <= 1) return `This single image is one photo of the item.`;
  return (
    `This single image is a ${cols}×${rows} grid combining ${cellCount} separate photos of the SAME item, ` +
    `read left-to-right, top-to-bottom (cell 1 = top-left). ` +
    `White padding around a photo is just letterboxing, not part of the item. ` +
    `Treat every cell as a distinct photo of this one listing — multiple angles are normal, not suspicious.`
  );
}
