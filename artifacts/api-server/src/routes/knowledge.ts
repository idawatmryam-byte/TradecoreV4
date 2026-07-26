/**
 * TradeCore Pro — knowledge routes
 *
 * A read model, in the strict sense: these handlers load closed trades, run
 * pure functions over them, and return the result. Nothing here writes, and
 * nothing here is reachable from the scan loop — which is what makes the whole
 * knowledge layer provably incapable of changing a trading decision.
 */
import { Router, type IRouter } from "express";
import { GetKnowledgeResponse } from "@workspace/api-zod";
import { knowledgeOverview } from "../lib/knowledge/knowledgeService";

const router: IRouter = Router();

router.get("/knowledge", async (req, res): Promise<void> => {
  const overview = await knowledgeOverview(req.userId!, req.section!);

  res.json(GetKnowledgeResponse.parse({
    executionTarget: overview.executionTarget,
    asOf: new Date(overview.knowledge.asOf).toISOString(),
    totalTrades: overview.knowledge.totalTrades,
    baselineWinRate: overview.knowledge.baselineWinRate,
    minSamples: overview.knowledge.minSamples,
    fdr: overview.knowledge.fdr,
    cellsTested: overview.knowledge.cellsTested,
    cells: overview.knowledge.cells,
    calibration: {
      gated: overview.calibration.gated,
      minSamples: overview.calibration.minSamples,
      totalSamples: overview.calibration.totalSamples,
      trainSamples: overview.calibration.trainSamples,
      validationSamples: overview.calibration.validationSamples,
      samplesNeeded: overview.calibration.samplesNeeded,
      raw: overview.calibration.raw,
      calibrated: overview.calibration.calibrated,
      climatologyBrier: overview.calibration.climatologyBrier,
      beatsClimatology: overview.calibration.beatsClimatology,
      bins: overview.calibration.bins,
    },
  }));
});

export default router;
