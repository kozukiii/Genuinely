import { Router } from "express";
import { searchAll } from "../controllers/searchController";


const router = Router();

// GET /api/search?query=...&limit=16
router.get("/", searchAll);

export default router;
