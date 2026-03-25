export function getHighResImage(url?: string, source?: string): string {
  if (!url || !url.startsWith("http")) return "/placeholder.jpg";

  if (source === "marketplace") {
    return url;
  }

  const upgraded = url.replace(/s-l\d+\.jpg/i, "s-l1600.jpg");
  return `/api/proxy-image?url=${encodeURIComponent(upgraded)}`;
}