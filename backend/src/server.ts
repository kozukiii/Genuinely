import dotenv from "dotenv";
dotenv.config({ quiet: true });

import express from "express";
import cors from "cors";
import { rateLimit } from "express-rate-limit";
import searchRoutes from "./routes/searchRoutes";
import imageProxyRoutes from "./routes/imageProxyRoutes";
import marketplaceRoutes from "./routes/marketplaceRoutes";
import featuredRoutes from "./routes/featuredRoutes";

const app = express();
app.disable("x-powered-by");

const allowedOrigins = (process.env.ALLOWED_ORIGIN ?? "http://localhost:5173").split(",").map(s => s.trim());
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) callback(null, true);
    else callback(new Error("Not allowed by CORS"));
  },
}));

const limiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please slow down." },
});

app.use(express.json({ limit: "5mb" }));

// --- API router (keeps server.ts clean as the app grows) ---
const api = express.Router();

// Health check lives inside /api
api.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// Rate limit all non-health routes
api.use("/search", limiter, searchRoutes);
api.use("/marketplace", limiter, marketplaceRoutes);
api.use("/proxy-image", limiter, imageProxyRoutes);
api.use("/featured", featuredRoutes);

// Mount all API routes under /api
app.use("/api", api);

// Server start
const PORT = Number(process.env.PORT ?? 3000);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Backend running on port ${PORT}`);
});
