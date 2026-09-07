import { diagnostic, failureKind, imageIdentity } from "../utils/analysisDiagnostics";

// Bound image downloads across listings, not just within one listing. A search
// can contain hundreds of photos; opening them all at once causes timeouts.
const MAX_DOWNLOADS = 8;
let active = 0;
const waiting: Array<() => void> = [];

export async function fetchVisionImage(url: string): Promise<Buffer | null> {
  const queuedAt = Date.now();
  if (active >= MAX_DOWNLOADS) await new Promise<void>((resolve) => waiting.push(resolve));
  else active++;
  const startedAt = Date.now();
  let status: number | null = null;
  let bytes = 0;
  let outcome = "empty_body";
  try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8_000);
      try {
        const res = await fetch(url, { signal: controller.signal });
        status = res.status;
        if (res.ok) {
          const type = res.headers.get("content-type") ?? "";
          if (type && !type.toLowerCase().startsWith("image/")) {
            outcome = "invalid_content_type";
            await res.body?.cancel();
            return null;
          }
          // Keep the timeout active until the body has finished downloading.
          const buffer = Buffer.from(await res.arrayBuffer());
          bytes = buffer.length;
          if (bytes) outcome = "ok";
          if (buffer.length) return buffer;
        } else {
          outcome = "http_error";
          await res.body?.cancel();
        }
      } catch (error) {
        outcome = failureKind(error);
        // Report failure without logging signed image URLs.
      } finally {
        clearTimeout(timer);
      }
    return null;
  } finally {
    diagnostic("ebay_image_download", { ...imageIdentity(url), status, bytes, outcome,
      queueMs: startedAt - queuedAt, downloadMs: Date.now() - startedAt });
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}
