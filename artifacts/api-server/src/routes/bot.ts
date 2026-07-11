import { Router, type IRouter } from "express";
import { botEngine } from "../lib/botEngine";
import { StartBacktestBody, GetBacktestStatusResponse, StartBacktestResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/bot/status", async (_req, res): Promise<void> => {
  res.json(botEngine.getState());
});

// Full per-symbol pipeline decision trace from the most recent scan.
router.get("/bot/decisions", async (_req, res): Promise<void> => {
  res.json(botEngine.getDecisions());
});

// Aggregated "why is nothing trading" summary across all evaluated symbols.
router.get("/bot/blocking-summary", async (_req, res): Promise<void> => {
  res.json(botEngine.getBlockingSummary());
});

router.post("/bot/start", async (req, res): Promise<void> => {
  await botEngine.start();
  req.log.info("Bot started via API");
  res.json(botEngine.getState());
});

router.post("/bot/stop", async (req, res): Promise<void> => {
  await botEngine.stop();
  req.log.info("Bot stopped via API");
  res.json(botEngine.getState());
});

router.post("/bot/backtest", async (req, res): Promise<void> => {
  const body = StartBacktestBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  if (botEngine.getBacktestStatus().running) {
    res.status(409).json({ error: "Backtest already running" });
    return;
  }

  // Fire-and-forget; progress tracked via GET /bot/backtest/status
  await botEngine.startBacktest(body.data.days);
  req.log.info({ days: body.data.days }, "Backtest started via API");
  res.status(202).json(StartBacktestResponse.parse(botEngine.getBacktestStatus()));
});

router.get("/bot/backtest/status", async (_req, res): Promise<void> => {
  res.json(GetBacktestStatusResponse.parse(botEngine.getBacktestStatus()));
});

// Reset the risk pause that is triggered after 3 consecutive risk violations.
// Call this after investigating the violations; trading resumes on the next scan.
router.post("/bot/reset-risk-pause", async (req, res): Promise<void> => {
  const { paused, violationCount } = botEngine.getRiskStatus();
  if (!paused) {
    res.status(200).json({ message: "Bot is not risk-paused — nothing to reset", ...botEngine.getState() });
    return;
  }
  botEngine.resetRiskPause();
  req.log.info({ previousViolationCount: violationCount }, "Risk pause reset via API");
  res.json({ message: "Risk pause cleared — trading will resume on next scan", ...botEngine.getState() });
});

export default router;
