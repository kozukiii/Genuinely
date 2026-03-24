import { Router } from "express";
import { searchMarketplace } from "../controllers/marketplaceController";
const router = Router();

router.get("/search", searchMarketplace);

export default router;