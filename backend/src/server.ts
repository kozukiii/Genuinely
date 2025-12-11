import dotenv from "dotenv";
dotenv.config();
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import ebayRoutes from "./routes/ebayRoutes";





const app = express();
app.use(cors());
app.use(express.json());

// eBay routes
app.use("/api/ebay", ebayRoutes);

// Image proxy
app.get("/proxy-image", async (req, res) => {
  const url = req.query.url as string;
  if (!url) return res.status(400).send("Missing URL");

  try {
    const response = await fetch(url);
    const buffer = Buffer.from(await response.arrayBuffer());

    res.setHeader("Content-Type", response.headers.get("content-type") || "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(buffer);
  } catch {
    res.status(500).send("Proxy failed");
  }
});

const PORT = 3000;
app.listen(PORT, () =>
  console.log(`✅ Backend running on http://localhost:${PORT}`)
);
