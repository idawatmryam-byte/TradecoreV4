import { Router, type IRouter } from "express";
import { db, botConfigTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { getOrCreateEngine } from "../lib/engineRegistry";
import { isDemoUser } from "../middleware/demoGuard";
import { buildDemoStatus } from "../lib/demoStatus";
import { DemoDataUnavailableError } from "../lib/execution/demoMarketData";

const router: IRouter = Router();

router.get("/bot/status", async (req, res): Promise<void> => {
  // The read-only demo has no live engine — serve a DB-derived snapshot so the
  // dashboard hero shows the seeded account's real aggregates (balance, today's
  // P&L, win rate) instead of an empty null state.
  if (await isDemoUser(req.userId!)) {
    res.json(await buildDemoStatus(req.userId!, req.section!));
    return;
  }
  res.json(getOrCreateEngine(req.userId!, req.section!).getState());
});

// Full per-symbol pipeline decision trace from the most recent scan.
router.get("/bot/decisions", async (req, res): Promise<void> => {
  res.json(getOrCreateEngine(req.userId!, req.section!).getDecisions());
});

// Aggregated "why is nothing trading" summary across all evaluated symbols.
router.get("/bot/blocking-summary", async (req, res): Promise<void> => {
  res.json(getOrCreateEngine(req.userId!, req.section!).getBlockingSummary());
});

router.post("/bot/start", async (req, res): Promise<void> => {
  const engine = getOrCreateEngine(req.userId!, req.section!);
  try {
    await engine.start();
  } catch (err) {
    // A start that cannot proceed is a PRECONDITION problem, not a server
    // fault: missing credentials, or a deployment with no forex demo data
    // source. Letting these reach the global handler turned every one of them
    // into an opaque 500, and the dashboard — which had no error branch at all
    // — showed nothing. The button appeared to do nothing and the engine
    // silently stayed stopped, which is the single worst way to fail here.
    if (err instanceof DemoDataUnavailableError) {
      req.log.warn({ userId: req.userId, section: req.section }, "Start refused: demo data unavailable");
      res.status(503).json({ error: err.message, code: "DEMO_DATA_UNAVAILABLE" });
      return;
    }
    const message = err instanceof Error ? err.message : "Failed to start the engine";
    if (/no (binance|oanda) (api )?credentials/i.test(message)) {
      req.log.warn({ userId: req.userId, section: req.section }, "Start refused: credentials missing");
      res.status(400).json({ error: message, code: "CREDENTIALS_MISSING" });
      return;
    }
    throw err;
  }

  // Starting a section's engine is as deliberate as configuring it, so it
  // counts as setting the market up. Belt and braces alongside PUT /config —
  // a section can't reach a running engine without being genuinely chosen.
  await db
    .update(botConfigTable)
    .set({ activated: true })
    .where(and(eq(botConfigTable.userId, req.userId!), eq(botConfigTable.section, req.section!)));

  req.log.info({ userId: req.userId, section: req.section }, "Bot started via API");
  res.json(engine.getState());
});

router.post("/bot/stop", async (req, res): Promise<void> => {
  const engine = getOrCreateEngine(req.userId!, req.section!);
  await engine.stop();
  req.log.info({ userId: req.userId }, "Bot stopped via API");
  res.json(engine.getState());
});

// Reset the risk pause that is triggered after 3 consecutive risk violations.
// Call this after investigating the violations; trading resumes on the next scan.
router.post("/bot/reset-risk-pause", async (req, res): Promise<void> => {
  const engine = getOrCreateEngine(req.userId!, req.section!);
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
