import { Router } from "express";
import { overviewSearch, rateLimits, itemGroup } from "../controllers/ebayController";

const router = Router();

router.get("/overview", overviewSearch);
router.get("/rate-limits", rateLimits);
router.get("/item-group/:itemGroupId", itemGroup);

export default router;
