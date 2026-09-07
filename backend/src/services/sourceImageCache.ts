import fetch from "node-fetch";
import dns from "dns/promises";
import net from "net";
import { Readable } from "stream";
import { diagnostic, imageIdentity } from "../utils/analysisDiagnostics";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 3;
const ALLOWED_HOSTS = new Set((process.env.IMAGE_PROXY_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean));

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIp(address: string): boolean {
  if (net.isIPv4(address)) {
    return isPrivateIpv4(address);
  }

  if (net.isIPv6(address)) {
    const normalized = address.toLowerCase();
    const mappedIpv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    if (mappedIpv4) return isPrivateIpv4(mappedIpv4);

    return (
      normalized === "::1" ||
      normalized === "::" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe80:") ||
      normalized.startsWith("ff")
    );
  }

  return true;
}

async function assertSafeImageUrl(rawUrl: string): Promise<URL> {
  const parsed = new URL(rawUrl);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Unsupported URL protocol");
  }

  const hostname = parsed.hostname.toLowerCase();
  if (ALLOWED_HOSTS.size > 0 && !ALLOWED_HOSTS.has(hostname)) {
    throw new Error("Image host is not allowed");
  }

  const addresses = net.isIP(hostname)
    ? [{ address: hostname }]
    : await dns.lookup(hostname, { all: true, verbatim: true });

  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateIp(address))) {
    throw new Error("Image URL resolves to a private address");
  }

  return parsed;
}

async function fetchSafeImage(rawUrl: string, redirects = 0): Promise<Awaited<ReturnType<typeof fetch>>> {
  const url = await assertSafeImageUrl(rawUrl);
  const response = await fetch(url.toString(), {
    redirect: "manual",
    timeout: FETCH_TIMEOUT_MS,
    size: MAX_IMAGE_BYTES,
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1)",
      "Referer": "https://www.ebay.com/",
    },
  });

  if ([301, 302, 303, 307, 308].includes(response.status)) {
    (response.body as Readable | null)?.destroy();
    if (redirects >= MAX_REDIRECTS) {
      throw new Error("Too many redirects");
    }

    const location = response.headers.get("location");
    if (!location) {
      throw new Error("Redirect missing location");
    }

    return fetchSafeImage(new URL(location, url).toString(), redirects + 1);
  }

  return response;
}


export interface SourceImage { buffer: Buffer; contentType: string }

export class ImageFetchError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

// Originals and URL keys live only in bounded RAM, never on persistent disk.
export class SourceImageCache {
  private entries = new Map<string, { image: SourceImage; expires: number }>();
  private pending = new Map<string, Promise<SourceImage>>();
  private bytes = 0;
  constructor(private maxBytes = 32 * 1024 * 1024, private ttlMs = 5 * 60 * 1000, private maxEntries = 128) {}
  private remove(key: string) {
    const entry = this.entries.get(key);
    if (entry) { this.bytes -= entry.image.buffer.length; this.entries.delete(key); }
  }
  sweep(now = Date.now()) {
    for (const [key, entry] of this.entries) if (entry.expires <= now) this.remove(key);
  }
  async get(url: string, download: () => Promise<SourceImage>): Promise<SourceImage> {
    this.sweep();
    const cached = this.entries.get(url);
    if (cached) {
      this.entries.delete(url);
      this.entries.set(url, cached);
      diagnostic("source_image_cache", { ...imageIdentity(url), result: "hit" });
      return cached.image;
    }
    const inflight = this.pending.get(url);
    if (inflight) {
      diagnostic("source_image_cache", { ...imageIdentity(url), result: "joined" });
      return inflight;
    }
    if (this.pending.size >= 256) throw new ImageFetchError(503, "Image queue is full");
    diagnostic("source_image_cache", { ...imageIdentity(url), result: "miss" });
    const task = Promise.resolve().then(download).then((image) => {
      if (image.buffer.length <= this.maxBytes) {
        while (this.entries.size && (this.bytes + image.buffer.length > this.maxBytes || this.entries.size >= this.maxEntries)) {
          this.remove(this.entries.keys().next().value!);
        }
        this.entries.set(url, { image, expires: Date.now() + this.ttlMs });
        this.bytes += image.buffer.length;
      }
      return image;
    }).finally(() => { this.pending.delete(url); });
    this.pending.set(url, task);
    return task;
  }
}

const cache = new SourceImageCache();
setInterval(() => cache.sweep(), 30_000).unref();
let active = 0;
const waiting: Array<() => void> = [];

export function getSourceImage(url: string): Promise<SourceImage> {
  return cache.get(url, async () => {
    const queuedAt = Date.now();
    if (active >= 8) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    const startedAt = Date.now();
    try {
      const response = await fetchSafeImage(url);
      if (!response.ok) {
        (response.body as Readable | null)?.destroy();
        throw new ImageFetchError(response.status, "Image unavailable");
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.toLowerCase().startsWith("image/")) {
        (response.body as Readable | null)?.destroy();
        throw new ImageFetchError(502, "Unexpected content type");
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer.length) throw new ImageFetchError(502, "Empty image");
      diagnostic("source_image_download", { ...imageIdentity(url), bytes: buffer.length,
        queueMs: startedAt - queuedAt, elapsedMs: Date.now() - startedAt });
      return { buffer, contentType };
    } finally {
      const next = waiting.shift();
      if (next) next(); else active--;
    }
  });
}
