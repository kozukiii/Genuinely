import { Router } from "express";
import { getMarketplaceItem } from "../controllers/marketplaceController";
const router = Router();

router.get("/item/:id", getMarketplaceItem);

export default router;