import { Request, Response } from "express";
import { searchMarketplaceListings, getMarketplaceListing } from "../services/marketplaceService";
import { extractClientIp, getLocationFromIp, getMarketplaceSearchLocation } from "../utils/geoIp";

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
    const query = String(req.query.q ?? "").trim();
    const requestedLocation = String(req.query.location ?? "").trim();

    if (!query) {
      return res.status(400).json({ error: "Missing q" });
    }

    const geoLocation = requestedLocation
      ? null
      : getMarketplaceSearchLocation(
          await getLocationFromIp(extractClientIp(req as any)).catch(() => null)
        );
    const marketplaceSearchLocation = requestedLocation
      ? { location: requestedLocation }
      : geoLocation;

    if (!marketplaceSearchLocation) {
      return res.status(400).json({ error: "Missing location and GeoIP lookup failed" });
    }

    const listings = await searchMarketplaceListings({
      query,
      ...marketplaceSearchLocation,
    });

    res.json(listings);
  } catch (err: any) {
    console.error("Marketplace error:", err);
    const message = err?.message ?? err?.error?.message ?? String(err);
    res.status(500).json({ error: message });
  }
}
