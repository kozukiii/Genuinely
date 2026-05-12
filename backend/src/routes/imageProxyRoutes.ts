// routes/imageProxyRoutes.ts
import { Router } from "express";
import fetch from "node-fetch";
import dns from "dns/promises";
import net from "net";

const router = Router();
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 3;
const ALLOWED_HOSTS = new Set(
  (process.env.IMAGE_PROXY_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean)
);

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

router.get("/", async (req, res) => {
  const url = typeof req.query.url === "string" ? req.query.url : "";
  if (!url) return res.status(400).send("Missing URL");

  try {
    const response = await fetchSafeImage(url);

    if (!response.ok) {
      return res.status(response.status).send("Image unavailable");
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.startsWith("image/")) {
      return res.status(502).send("Unexpected content type");
    }

    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > MAX_IMAGE_BYTES) {
      return res.status(413).send("Image too large");
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(buffer);
  } catch (err: any) {
    const message = err?.message ?? "Proxy failed";
    if (/protocol|private address|host is not allowed|invalid url/i.test(message)) {
      return res.status(400).send(message);
    }
    if (/too many redirects|redirect missing location/i.test(message)) {
      return res.status(502).send(message);
    }
    res.status(500).send("Proxy failed");
  }
});

export default router;
