import { Router } from "express";
import { overviewSearch, rateLimits } from "../controllers/ebayController";

const router = Router();


router.get("/overview", overviewSearch);
router.get("/rate-limits", rateLimits);

export default router;
