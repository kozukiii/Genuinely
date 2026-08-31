import sharp from "sharp";

// ─── Image grid stitching ──────────────────────────────────────────────────
//
// Vision models on Groq tile + downscale every image they
// receive, and cap the number of image blocks per request. Sending a listing's
// photos one-by-one burns that cap fast — often only one listing fits per call.
//
// Stitching a listing's photos into a single padded grid collapses N images to
// 1, so several listings fit in one call.
//
// Vision token cost on the model scales with TOTAL PIXEL AREA, not image count.
// So instead of capping the photo count, we cap the grid's overall size
// (GRID_MAX_PX) and let cells shrink as more photos are packed in. A 4-photo
// grid and a 9-photo grid then cost roughly the same number of tokens. Listings
// with more than 9 photos use another grid, up to the model's three-block cap.

export const MAX_CELLS = 9;   // up to a 3×3 grid per image block
export const MAX_IMAGE_BLOCKS = 3;
export const MAX_SOURCE_IMAGES = MAX_CELLS * MAX_IMAGE_BLOCKS;
const CELL_TARGET_PX = 512;   // desired per-cell resolution. Grid grows WITH photo count
                              // (3 photos → small grid, cheap; 9 → larger) until it would
                              // exceed GRID_MAX_PX, at which point cells shrink to stay capped.
const CELL_MAX_PX = 1024;     // a single-photo "grid" gets at most this resolution
const CELL_MIN_PX = 192;      // floor so cells stay legible in a dense grid
const GRID_MAX_PX = 1280;     // hard ceiling on the composite's longest edge — bounds worst-case
                              // token cost and keeps the base64 body under Groq's 4MB cap.
const BG = { r: 255, g: 255, b: 255, alpha: 1 };

// Partition every source photo into the fewest possible stitched image blocks.
// The configured Groq model accepts at most three blocks, and each grid keeps at
// most 9 cells legible. Exceeding that capacity is an explicit error: callers
// must never receive a plausible-looking analysis made from silently truncated
// photos.
export function planImageBlocks(
  count: number,
  maxBlocks = MAX_IMAGE_BLOCKS,
  maxCells = MAX_CELLS,
): number[][] {
  if (!Number.isInteger(count) || count < 0) throw new RangeError(`Invalid image count: ${count}`);
  const capacity = maxBlocks * maxCells;
  if (count > capacity) {
    throw new RangeError(`Listing has ${count} images; vision capacity is ${capacity} (${maxBlocks} blocks x ${maxCells} cells)`);
  }
  if (count === 0) return [];

  const blocks: number[][] = [];
  for (let start = 0; start < count; start += maxCells) {
    blocks.push(Array.from({ length: Math.min(maxCells, count - start) }, (_, i) => start + i));
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
  // Near-square layout for any count: cols = ceil(sqrt(n)), rows packs the rest.
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  return { cols, rows };
}

/**
 * Stitch up to MAX_CELLS image buffers into a single padded grid JPEG.
 * Returns null if no buffer could be decoded.
 */
export async function stitchBuffers(buffers: Buffer[]): Promise<StitchResult | null> {
  if (buffers.length > MAX_CELLS) {
    throw new RangeError(`Cannot place ${buffers.length} images in one ${MAX_CELLS}-cell grid`);
  }
  const usable = buffers;
  if (usable.length === 0) return null;

  // Cells default to CELL_TARGET_PX so the grid scales with photo count (a 2×2
  // grid is physically smaller — and cheaper — than a 3×3). Only once the grid
  // would exceed GRID_MAX_PX do cells shrink to keep the total bounded. A lone
  // photo is allowed up to CELL_MAX_PX.
  const { cols, rows } = gridDims(usable.length);
  const dim = Math.max(cols, rows);
  const target = dim === 1 ? CELL_MAX_PX : CELL_TARGET_PX;
  const cellPx = Math.max(
    CELL_MIN_PX,
    Math.min(target, Math.floor(GRID_MAX_PX / dim)),
  );

  // Resize each source to fill a square cellPx cell (center-crop, no padding).
  // `cover` spends every pixel on the photo instead of white letterbox bars —
  // aspect ratio is held (no stretching that would distort defects); only the
  // extreme edges are trimmed.
  const cells = await Promise.all(
    usable.map(async (buf) => {
      try {
        return await sharp(buf)
          .resize(cellPx, cellPx, { fit: "cover", position: "centre" })
          .toBuffer();
      } catch {
        return null;
      }
    })
  );

  const valid = cells.filter((c): c is Buffer => c !== null);
  if (valid.length === 0) return null;
  if (valid.length !== usable.length) {
    throw new Error(`Image stitching decoded only ${valid.length} of ${usable.length} source images`);
  }

  // Recompute dims in case some sources failed to decode.
  const dims = gridDims(valid.length);
  const composite = valid.map((input, i) => ({
    input,
    left: (i % dims.cols) * cellPx,
    top: Math.floor(i / dims.cols) * cellPx,
  }));

  const canvas = sharp({
    create: {
      width: dims.cols * cellPx,
      height: dims.rows * cellPx,
      channels: 3,
      background: BG,
    },
  });

  const jpeg = await canvas.composite(composite).jpeg({ quality: 82 }).toBuffer();
  return {
    dataUrl: `data:image/jpeg;base64,${jpeg.toString("base64")}`,
    cellCount: valid.length,
    cols: dims.cols,
    rows: dims.rows,
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
  if (buffers.length !== dataUrls.length) {
    throw new Error(`Decoded only ${buffers.length} of ${dataUrls.length} image data URLs`);
  }
  return stitchBuffers(buffers);
}

/** Stitch every buffer into one to three grids without truncating any source image. */
export async function stitchBufferBlocks(buffers: Buffer[]): Promise<StitchResult[]> {
  const groups = planImageBlocks(buffers.length);
  const grids = await Promise.all(groups.map((indices) => stitchBuffers(indices.map((i) => buffers[i]))));
  if (grids.some((grid) => grid === null)) throw new Error("Image stitching produced an empty grid");
  const complete = grids as StitchResult[];
  const stitchedCount = complete.reduce((sum, grid) => sum + grid.cellCount, 0);
  if (stitchedCount !== buffers.length) {
    throw new Error(`Image stitching retained ${stitchedCount} of ${buffers.length} source images`);
  }
  return complete;
}

/** Stitch every data URL into one to three grids without truncating any source image. */
export async function stitchDataUrlBlocks(dataUrls: string[]): Promise<StitchResult[]> {
  const buffers = dataUrls.map(dataUrlToBuffer).filter((b): b is Buffer => b !== null);
  if (buffers.length !== dataUrls.length) {
    throw new Error(`Decoded only ${buffers.length} of ${dataUrls.length} image data URLs`);
  }
  return stitchBufferBlocks(buffers);
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
    `Each cell is cropped to fill its square; any blank white cell at the end is an empty slot, not part of the item. ` +
    `Treat every cell as a distinct photo of this one listing — multiple angles are normal, not suspicious.`
  );
}
