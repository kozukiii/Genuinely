import fetch from "node-fetch";
import { mapEbaySummary } from "../utils/mapEbaySummary";

const EBAY_SEARCH = "https://api.ebay.com/buy/browse/v1/item_summary/search";
const EBAY_ITEM = "https://api.ebay.com/buy/browse/v1/item";


export async function getEbayItemsWithDetails(
  query: string,
  limit: number = 8
) {
  const token = process.env.EBAY_PROD_TOKEN;
  if (!token) {
    throw new Error("EBAY_PROD_TOKEN is missing");
  }

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
        images: [
          summary.image,
          ...summary.additionalImages
        ].filter(Boolean)
      };
    })
  );

  return detailedItems;
}

