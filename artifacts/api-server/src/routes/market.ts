import { Router, type IRouter } from "express";
import { botEngine } from "../lib/botEngine";

const router: IRouter = Router();

// Live market monitor: real ticker snapshots + exchange connection health.
router.get("/market/live", async (_req, res): Promise<void> => {
  res.json(botEngine.getMarketMonitor());
});

export default router;
