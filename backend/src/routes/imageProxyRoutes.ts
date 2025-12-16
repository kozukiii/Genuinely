// routes/imageProxyRoutes.ts
import { Router } from "express";
import fetch from "node-fetch";

const router = Router();

router.get("/", async (req, res) => {
  const url = req.query.url as string;
  if (!url) return res.status(400).send("Missing URL");

  try {
    const response = await fetch(url);
    const buffer = Buffer.from(await response.arrayBuffer());

    res.setHeader("Content-Type", response.headers.get("content-type") || "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(buffer);
  } catch (err) {
    res.status(500).send("Proxy failed");
  }
});

export default router;
