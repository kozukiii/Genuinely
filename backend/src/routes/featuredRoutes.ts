import { Router } from "express";
import { getFeatured } from "../services/featuredCache";

const router = Router();

router.get("/", (_req, res) => {
  const result = getFeatured();
  res.json(result);
});

export default router;
