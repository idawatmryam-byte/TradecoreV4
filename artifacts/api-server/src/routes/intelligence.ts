import { Router } from "express";
import { z } from "zod";
import { getOrCreateEngine } from "../lib/engineRegistry";
import { logger } from "../lib/logger";

const router = Router();
const DecisionIdSchema = z.string().uuid();

router.get("/intelligence/shadow", (req, res) => {
  try {
    const runs = getOrCreateEngine(req.userId!, req.section!).getShadowCouncilRuns();
    res.json([...runs].sort((a, b) => b.generatedAt.localeCompare(a.generatedAt)));
  } catch (err) {
    logger.error({ err }, "GET /intelligence/shadow failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/intelligence/portfolio", async (req, res) => {
  try {
    const projection = await getOrCreateEngine(req.userId!, req.section!).getPortfolioIntelligence();
    res.json(projection);
  } catch (err) {
    logger.error({ err, userId: req.userId, section: req.section }, "GET /intelligence/portfolio failed");
    res.status(500).json({
      error: "Portfolio Intelligence could not build a validated projection.",
      code: "PORTFOLIO_PROJECTION_FAILED",
    });
  }
});

router.get("/intelligence/shadow/:decisionId/replay", (req, res) => {
  const parsed = DecisionIdSchema.safeParse(req.params.decisionId);
  if (!parsed.success) return res.status(400).json({ error: "Invalid decision identifier" });
  try {
    const run = getOrCreateEngine(req.userId!, req.section!)
      .getShadowCouncilRuns()
      .find((candidate) => candidate.decision.decisionId === parsed.data);
    if (!run) return res.status(404).json({ error: "Shadow decision not found in the current engine projection" });
    return res.json(run.replay);
  } catch (err) {
    logger.error({ err }, "GET /intelligence/shadow/:decisionId/replay failed");
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;

