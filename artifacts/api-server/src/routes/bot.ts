import { Router, type IRouter } from "express";
import { getOrCreateEngine } from "../lib/engineRegistry";
import { StartBacktestBody, GetBacktestStatusResponse, StartBacktestResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/bot/status", async (req, res): Promise<void> => {
  res.json(getOrCreateEngine(req.userId!).getState());
});

// Full per-symbol pipeline decision trace from the most recent scan.
router.get("/bot/decisions", async (req, res): Promise<void> => {
  res.json(getOrCreateEngine(req.userId!).getDecisions());
});

// Aggregated "why is nothing trading" summary across all evaluated symbols.
router.get("/bot/blocking-summary", async (req, res): Promise<void> => {
  res.json(getOrCreateEngine(req.userId!).getBlockingSummary());
});

router.post("/bot/start", async (req, res): Promise<void> => {
  const engine = getOrCreateEngine(req.userId!);
  await engine.start();
  req.log.info({ userId: req.userId }, "Bot started via API");
  res.json(engine.getState());
});

router.post("/bot/stop", async (req, res): Promise<void> => {
  const engine = getOrCreateEngine(req.userId!);
  await engine.stop();
  req.log.info({ userId: req.userId }, "Bot stopped via API");
  res.json(engine.getState());
});

router.post("/bot/backtest", async (req, res): Promise<void> => {
  const body = StartBacktestBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const engine = getOrCreateEngine(req.userId!);
  if (engine.getBacktestStatus().running) {
    res.status(409).json({ error: "Backtest already running" });
    return;
  }

  // Fire-and-forget; progress tracked via GET /bot/backtest/status
  await engine.startBacktest(body.data.days);
  req.log.info({ days: body.data.days, userId: req.userId }, "Backtest started via API");
  res.status(202).json(StartBacktestResponse.parse(engine.getBacktestStatus()));
});

router.get("/bot/backtest/status", async (req, res): Promise<void> => {
  res.json(GetBacktestStatusResponse.parse(getOrCreateEngine(req.userId!).getBacktestStatus()));
});

// Reset the risk pause that is triggered after 3 consecutive risk violations.
// Call this after investigating the violations; trading resumes on the next scan.
router.post("/bot/reset-risk-pause", async (req, res): Promise<void> => {
  const engine = getOrCreateEngine(req.userId!);
  const { paused, violationCount } = engine.getRiskStatus();
  if (!paused) {
    res.status(200).json({ message: "Bot is not risk-paused — nothing to reset", ...engine.getState() });
    return;
  }
  await engine.resetRiskPause();
  req.log.info({ previousViolationCount: violationCount, userId: req.userId }, "Risk pause reset via API");
  res.json({ message: "Risk pause cleared — trading will resume on next scan", ...engine.getState() });
});

export default router;
