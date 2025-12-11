import dotenv from "dotenv";
dotenv.config();
import express from "express";
import cors from "cors";
import ebayRoutes from "./routes/ebayRoutes";
import proxyRoutes from "./routes/proxyRoutes";
const app = express();
app.use(cors());
app.use(express.json());

// eBay routes
app.use("/api/ebay", ebayRoutes);

// Image proxy
app.use("/api/proxy-image", proxyRoutes);

const PORT = 3000;
app.listen(PORT, () =>
  console.log(`✅ Backend running on http://localhost:${PORT}`)
);
