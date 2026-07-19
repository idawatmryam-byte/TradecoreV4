import { Router, type IRouter } from "express";
import { getOrCreateEngine } from "../lib/engineRegistry";

const router: IRouter = Router();

router.get("/scanner", async (req, res): Promise<void> => {
  const rows = getOrCreateEngine(req.userId!, req.section!).getScannerData();
  res.json(rows);
});

export default router;
