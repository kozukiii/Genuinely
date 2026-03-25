import { Router } from "express";
import { searchMarketplace, getMarketplaceItem } from "../controllers/marketplaceController";
const router = Router();

router.get("/search", searchMarketplace);
router.get("/item/:id", getMarketplaceItem);

export default router;