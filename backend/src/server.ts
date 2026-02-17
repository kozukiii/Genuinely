import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";

import ebayRoutes from "./routes/ebayRoutes";
import imageProxyRoutes from "./routes/imageProxyRoutes";

const app = express();
app.use(cors());
app.use(express.json());

// API groups
app.use("/api/ebay", ebayRoutes);
app.use("/api/proxy-image", imageProxyRoutes);

const PORT = 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Backend running on port ${PORT}`);
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});
