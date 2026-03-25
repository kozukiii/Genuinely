import { Request, Response } from "express";
import { searchMarketplaceListings, getMarketplaceListing } from "../services/marketplaceService";

export async function getMarketplaceItem(req: Request, res: Response) {
  const { id } = req.params;
  if (!id || !/^\d+$/.test(id)) {
    return res.status(400).json({ error: "Invalid listing id" });
  }

  try {
    const data = await getMarketplaceListing(id);
    res.json(data);
  } catch (err: any) {
    console.error("Marketplace item error:", err.message);
    res.status(500).json({ error: "Failed to fetch listing detail" });
  }
}

export async function searchMarketplace(req: Request, res: Response) {
  try {
    const { q, location } = req.query;

    if (!q || !location) {
      return res.status(400).json({ error: "Missing q or location" });
    }

    const listings = await searchMarketplaceListings({
      query: String(q),
      location: String(location),
    });

    res.json(listings);
  } catch (err: any) {
    console.error("Marketplace error:", err);
    res.status(500).json({ error: "Marketplace search failed" });
  }
}