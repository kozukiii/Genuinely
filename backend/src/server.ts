import dotenv from "dotenv";
dotenv.config({ quiet: true });

import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import passport from "passport";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import searchRoutes from "./routes/searchRoutes";
import imageProxyRoutes from "./routes/imageProxyRoutes";
import marketplaceRoutes from "./routes/marketplaceRoutes";
import featuredRoutes from "./routes/featuredRoutes";
import authRoutes from "./routes/authRoutes";
import savedRoutes from "./routes/savedRoutes";
import internalRoutes from "./routes/internalRoutes";

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1); // Render sits behind a load balancer that sets X-Forwarded-For

const allowedOrigins = (process.env.ALLOWED_ORIGIN ?? "http://localhost:5173").split(",").map(s => s.trim());
const trustedCsrfOrigins = new Set([
  ...allowedOrigins,
  ...(process.env.FRONTEND_URL ? [process.env.FRONTEND_URL] : []),
].filter(Boolean));

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) callback(null, true);
    else callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
}));

app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
}));

app.use((req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    next();
    return;
  }

  const source = req.headers.origin ?? req.headers.referer;
  const sourceValue = Array.isArray(source) ? source[0] : source;

  if (!sourceValue && process.env.NODE_ENV !== "production") {
    next();
    return;
  }

  try {
    const sourceOrigin = sourceValue ? new URL(sourceValue).origin : "";
    if (trustedCsrfOrigins.has(sourceOrigin)) {
      next();
      return;
    }
  } catch {
    // Fall through to rejection.
  }

  res.status(403).json({ error: "Untrusted request origin" });
});

const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please slow down." },
});

app.use(express.json({ limit: "5mb" }));
app.use(cookieParser());
app.use(passport.initialize());

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
api.use("/saved", savedRoutes);
api.use("/internal", internalRoutes);

// Mount all API routes under /api
app.use("/api", api);

// Auth routes live outside /api (OAuth redirects don't suit the /api prefix)
app.use("/auth", authRoutes);

// Server start
const PORT = Number(process.env.PORT ?? 3000);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Backend running on port ${PORT}`);
});
