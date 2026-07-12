import { Router, type IRouter } from "express";
import { getOrCreateEngine } from "../lib/engineRegistry";

const router: IRouter = Router();

// Live market monitor: real ticker snapshots + exchange connection health.
router.get("/market/live", async (req, res): Promise<void> => {
  res.json(getOrCreateEngine(req.userId!).getMarketMonitor());
});

export default router;
