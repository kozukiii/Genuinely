const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

export function getHighResImage(url?: string, source?: string): string {
  if (!url || !url.startsWith("http")) return "/placeholder.jpg";

  if (source === "marketplace") {
    return url;
  }

  // Only upgrade if eBay CDN URL — don't risk breaking non-eBay image URLs
  const isEbayCdn = url.includes("ebayimg.com");
  const upgraded = isEbayCdn ? url.replace(/s-l\d+\.jpg/i, "s-l500.jpg") : url;
  return `${API_BASE}/api/proxy-image?url=${encodeURIComponent(upgraded)}`;
}