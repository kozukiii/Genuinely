export function getHighResImage(url?: string): string {
  if (!url || !url.startsWith("http")) return "/placeholder.jpg";

  const proxyBase = "http://localhost:3000/proxy-image";

  // Upgrade to highest resolution eBay offers (s-l1600)
  const upgraded = url.replace(/s-l\d+\.jpg/i, "s-l1600.jpg");

  return `${proxyBase}?url=${encodeURIComponent(upgraded)}`;
}
