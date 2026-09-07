const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";
export const PLACEHOLDER_IMAGE = "/placeholder.svg";

function isMarketplaceListingPhoto(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();

    if (!/(^|[.-])scontent[.-]|(^|[.-])fbsbx[.-]/.test(host)) return false;
    if (host.startsWith("static.") || pathname.includes("/rsrc.php")) return false;
    if (/\.(?:svg|wasm|gif)(?:$|[?#])/.test(pathname)) return false;
    if (/\/t1[._]/.test(url)) return false;

    return true;
  } catch {
    return false;
  }
}

export function isDisplayableListingImage(url: unknown, source?: string): url is string {
  if (typeof url !== "string" || !url.startsWith("http")) return false;
  return source === "marketplace" ? isMarketplaceListingPhoto(url) : true;
}

export function getHighResImage(url?: string, source?: string): string {
  if (!isDisplayableListingImage(url, source)) return PLACEHOLDER_IMAGE;

  if (source === "marketplace") {
    return url;
  }

  // Preserve the source API URL so display and stitching reuse the same
  // temporary backend download, including its original resolution.
  return `${API_BASE}/api/proxy-image?url=${encodeURIComponent(url)}`;
}
