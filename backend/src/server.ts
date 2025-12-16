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
app.listen(PORT, () => {
  console.log(`✅ Backend running on http://localhost:${PORT}`);
});
