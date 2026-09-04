// Bound image downloads across listings, not just within one listing. A search
// can contain hundreds of photos; opening them all at once causes timeouts.
const MAX_DOWNLOADS = 8;
let active = 0;
const waiting: Array<() => void> = [];

export async function fetchVisionImage(url: string): Promise<Buffer | null> {
  if (active >= MAX_DOWNLOADS) await new Promise<void>((resolve) => waiting.push(resolve));
  else active++;
  try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8_000);
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (res.ok) {
          const type = res.headers.get("content-type") ?? "";
          if (type && !type.toLowerCase().startsWith("image/")) {
            await res.body?.cancel();
            return null;
          }
          // Keep the timeout active until the body has finished downloading.
          const buffer = Buffer.from(await res.arrayBuffer());
          if (buffer.length) return buffer;
        } else {
          await res.body?.cancel();
        }
      } catch {
        // Report failure without logging signed image URLs.
      } finally {
        clearTimeout(timer);
      }
    return null;
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}
