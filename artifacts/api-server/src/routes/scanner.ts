import { Router, type IRouter } from "express";
import { botEngine } from "../lib/botEngine";

const router: IRouter = Router();

router.get("/scanner", async (_req, res): Promise<void> => {
  const rows = botEngine.getScannerData();
  res.json(rows);
});

export default router;
