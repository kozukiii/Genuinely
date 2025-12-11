import { Router } from "express";
import fetch from "node-fetch";

const router = Router();

const upgradeEbayImageResolution = (rawUrl: string) =>
  rawUrl.replace(/(\/s-l)\d+(\.jpg)/i, "$11600$2");

router.get("/", async (req, res) => {
  const url = req.query.url as string;
  if (!url) return res.status(400).send("Missing URL");

  // Default to the highest resolution eBay provides if the caller hasn't
  // explicitly requested it.
  const upgradedUrl = upgradeEbayImageResolution(url);

  try {
    const response = await fetch(upgradedUrl);
    const buffer = Buffer.from(await response.arrayBuffer());

    res.setHeader("Content-Type", response.headers.get("content-type") || "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(buffer);
  } catch {
    res.status(500).send("Proxy failed");
  }
});

export default router;
