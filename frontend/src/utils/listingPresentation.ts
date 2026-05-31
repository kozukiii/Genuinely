import type { Listing } from "../types/Listing";

export const PRICE_BADGE_ORDER = ["GREAT PRICE", "GOOD PRICE", "FAIR PRICE", "HIGH PRICE", "RISKY PRICE"] as const;

export type PriceBadgeLabel = typeof PRICE_BADGE_ORDER[number];

export type PriceBadge = {
  label: PriceBadgeLabel;
  color: string;
  bg: string;
};

export function formatDeliveryType(type: string): string {
  return type.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

export function availabilityLabel(status?: Listing["availabilityStatus"]) {
  if (status === "sold") return "Sold";
  if (status === "ended") return "Ended";
  if (status === "removed") return "Unavailable";
  return null;
}

export function getPriceBadge(price: number, priceLow: number, priceHigh: number): PriceBadge {
  const mid = (priceLow + priceHigh) / 2;
  if (price < priceLow * 0.5) return { label: "RISKY PRICE", color: "#ef4444", bg: "rgba(239,68,68,0.08)" };
  if (price < priceLow) return { label: "GREAT PRICE", color: "#a855f7", bg: "rgba(168,85,247,0.08)" };
  if (price <= mid) return { label: "GOOD PRICE", color: "#22c55e", bg: "rgba(34,197,94,0.08)" };
  if (price <= priceHigh) return { label: "FAIR PRICE", color: "#facc15", bg: "rgba(250,204,21,0.08)" };
  return { label: "HIGH PRICE", color: "#ef4444", bg: "rgba(239,68,68,0.08)" };
}

export function getPriceBadgeTitle(label: string): string {
  switch (label) {
    case "RISKY PRICE":
      return "Far below the expected low price, which can be a risk signal.";
    case "GREAT PRICE":
      return "Under the expected low price, but still close enough to be reasonable.";
    case "GOOD PRICE":
      return "Below the middle of the expected market range.";
    case "FAIR PRICE":
      return "Within the expected market range, closer to the high side.";
    case "HIGH PRICE":
      return "Above the expected high price for similar listings.";
    case "No price to analyze":
      return "No fixed listing price is available to compare against the market range.";
    default:
      return "Based on how the listing price compares with the expected market range.";
  }
}
