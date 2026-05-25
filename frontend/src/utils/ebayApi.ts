const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

export interface EbayVariant {
  itemId: string;
  price: number;
  currency: string;
  imageUrl?: string;
  affiliateUrl: string;
  webUrl: string;
  shippingCost?: number;
  shippingCalculated?: boolean;
  availability: "IN_STOCK" | "LIMITED_STOCK" | "OUT_OF_STOCK" | "UNKNOWN";
  aspects: Record<string, string>;
}

export interface EbayItemGroup {
  itemGroupId: string;
  optionMatrix: Record<string, string[]>;
  variants: EbayVariant[];
}

export async function fetchItemGroup(itemGroupId: string): Promise<EbayItemGroup> {
  const res = await fetch(`${API_BASE}/api/ebay/item-group/${encodeURIComponent(itemGroupId)}`);
  if (!res.ok) {
    throw new Error(`Item group fetch failed: HTTP ${res.status}`);
  }
  return res.json() as Promise<EbayItemGroup>;
}
