/**
 * TradeCore Pro — portfolio-risk routes
 *
 * Read-only views over the portfolio-level risk the engine already enforces.
 * Nothing here changes engine state or places anything; the correlation gate
 * itself lives in the scan loop, and this is the window onto its inputs.
 */
import { Router, type IRouter } from "express";
import { GetPortfolioCorrelationResponse } from "@workspace/api-zod";
import { getOrCreateEngine } from "../lib/engineRegistry";

const router: IRouter = Router();

router.get("/portfolio/correlation", async (req, res): Promise<void> => {
  const engine = getOrCreateEngine(req.userId!, req.section!);
  const heatMap = await engine.correlationHeatMap();
  res.json(GetPortfolioCorrelationResponse.parse(heatMap));
});

export default router;
