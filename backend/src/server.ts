import dotenv from "dotenv";
dotenv.config({ quiet: true });

import express from "express";
import cors from "cors";
import searchRoutes from "./routes/searchRoutes";
import ebayRoutes from "./routes/ebayRoutes";
import imageProxyRoutes from "./routes/imageProxyRoutes";
import marketplaceRoutes from "./routes/marketplaceRoutes";



const app = express();
app.disable("x-powered-by");



app.use(cors());
app.use(express.json());

// --- API router (keeps server.ts clean as the app grows) ---
const api = express.Router();

// Health check lives inside /api
api.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// Feature route groups
api.use("/search", searchRoutes);
api.use("/ebay", ebayRoutes);
api.use("/marketplace", marketplaceRoutes);
api.use("/proxy-image", imageProxyRoutes);

// Mount all API routes under /api
app.use("/api", api);

// Server start
const PORT = Number(process.env.PORT ?? 3000);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Backend running on port ${PORT}`);
});
