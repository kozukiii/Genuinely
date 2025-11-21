import { Router } from "express";
import { overviewSearch } from "../controllers/ebayController";

const router = Router();


router.get("/overview", overviewSearch);

export default router;
