import { Request, Response } from "express";
import { searchMarketplaceListings } from "../services/marketplaceService";

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