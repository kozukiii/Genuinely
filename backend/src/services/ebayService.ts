import fetch from "node-fetch";
import { mapEbaySummary } from "../utils/mapEbaySummary";
import { getEbayAccessToken } from "./ebayTokenService";

const EBAY_SEARCH = "https://api.ebay.com/buy/browse/v1/item_summary/search";
const EBAY_ITEM = "https://api.ebay.com/buy/browse/v1/item";

// ---------------------------------------------------
// Fast multi-item search
// Pulls: summary + fullDescription ONLY
// Skips all heavy full-item metadata
// ---------------------------------------------------
export async function getEbayItemsWithDetails(
  query: string,
  limit: number = 8
) {
  const token = await getEbayAccessToken();

  // STEP 1 — Fetch summary items
  const searchRes = await fetch(
    `${EBAY_SEARCH}?q=${encodeURIComponent(query)}&limit=${limit}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  const searchJson = await searchRes.json();
  const summariesRaw = searchJson.itemSummaries || [];

  if (!Array.isArray(summariesRaw) || summariesRaw.length === 0) {
    return [];
  }

  const summaries = summariesRaw.map(mapEbaySummary);

  // STEP 2 — Fetch ONLY the full description for each item
  const detailedItems = await Promise.all(
    summaries.map(async (summary) => {
      const fullRes = await fetch(`${EBAY_ITEM}/${summary.id}`, {
        headers: { Authorization: `Bearer ${token}` }
      });

      const fullJson = await fullRes.json();

      // Only extract the description — skip ALL heavy fields
      const description = fullJson.description || summary.description || "";

      // Merge summary + description
      return {
        ...summary,
        fullDescription: description,
        allImages: [
          summary.image,
          ...summary.additionalImages
        ].filter(Boolean)
      };
    })
  );

  return detailedItems;
}

// ---------------------------------------------------
// Still available if you want single-item behavior
// ---------------------------------------------------
export async function getSingleEbayItem(query: string) {
  const items = await getEbayItemsWithDetails(query, 1);
  return items[0] ?? null;
}
