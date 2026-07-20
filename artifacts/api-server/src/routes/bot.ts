import { Router, type IRouter } from "express";
import { getOrCreateEngine, SECTIONS } from "../lib/engineRegistry";

const router: IRouter = Router();

router.get("/bot/status", async (req, res): Promise<void> => {
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
  // EXCLUSIVE MODE: only one section's engine runs at a time (user decision).
  // Starting this section stops the other one first. A stopped section's open
  // positions keep their exchange-side SL/TP (never unprotected), but lose
  // active management (TP1 ladder / trailing / time exits) until restarted.
  let stoppedOther: string | null = null;
  for (const other of SECTIONS) {
    if (other === req.section!) continue;
    const otherEngine = getOrCreateEngine(req.userId!, other);
    if (otherEngine.getState().running) {
      await otherEngine.stop();
      stoppedOther = other;
      req.log.info({ userId: req.userId, stopped: other, starting: req.section }, "Exclusive mode: sibling engine stopped");
    }
  }

  const engine = getOrCreateEngine(req.userId!, req.section!);
  await engine.start();
  req.log.info({ userId: req.userId, section: req.section }, "Bot started via API");
  res.json({
    ...engine.getState(),
    ...(stoppedOther && {
      note: `Only one engine runs at a time — the ${stoppedOther} engine was stopped. Its open positions keep their exchange-side stop-loss/take-profit.`,
    }),
  });
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
