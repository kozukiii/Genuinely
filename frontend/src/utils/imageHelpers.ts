export function getHighResImage(url?: string): string {
  if (!url || !url.startsWith("http")) return "/placeholder.jpg";

  // Upgrade to highest resolution eBay offers (s-l1600)
  const upgraded = url.replace(/s-l\d+\.jpg/i, "s-l1600.jpg");

  // 🔑 RELATIVE path — Vite will proxy this to the backend
  return `/api/proxy-image?url=${encodeURIComponent(upgraded)}`;
}
