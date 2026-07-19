/**
 * Strategy management routes
 *
 * GET  /strategies           — list all strategies with live config + performance
 * GET  /strategies/signals   — current opportunity rankings (live signals)
 * PUT  /strategies/:id       — update a strategy's config
 */
import { Router } from "express";
import { db } from "@workspace/db";
import { strategyConfigsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { ALL_STRATEGIES, DEFAULT_STRATEGY_CONFIGS } from "../lib/strategies";
import { loadStrategyConfigs } from "../lib/strategyConfigLoader";
import { getOrCreateEngine } from "../lib/engineRegistry";
import { logger } from "../lib/logger";
import { MIN_VIABLE_TAKE_PROFIT_PERCENT } from "../lib/tradingCosts";

const router = Router();

// ---------------------------------------------------------------------------
// GET /strategies
// ---------------------------------------------------------------------------

router.get("/strategies", async (req, res) => {
  try {
    const configs = await loadStrategyConfigs(req.userId!, req.section!);

    // Per-strategy performance from THIS user's LIVE closed trades. This used
    // to aggregate backtest_trades — so the Strategies page showed 0 trades /
    // $0 P&L for every strategy no matter how much the live engine traded
    // (observed and reported from the live demo). The cards answer "how is
    // each strategy actually doing?", and that means real trades.
    const perfRows = await db.execute(sql`
      SELECT
        t.strategy_id,
        COUNT(*)::int                                    AS total_trades,
        SUM(CASE WHEN t.pnl > 0 THEN 1 ELSE 0 END)::int  AS winning_trades,
        SUM(CASE WHEN t.pnl <= 0 THEN 1 ELSE 0 END)::int AS losing_trades,
        COALESCE(SUM(t.pnl), 0)::float                      AS total_pnl,
        COALESCE(AVG(CASE WHEN t.pnl > 0 THEN t.pnl END), 0)::float  AS avg_win,
        COALESCE(AVG(CASE WHEN t.pnl <= 0 THEN t.pnl END), 0)::float AS avg_loss,
        COALESCE(AVG(t.holding_seconds), 0)::float          AS avg_duration_seconds
      FROM trades t
      WHERE t.strategy_id IS NOT NULL
        AND t.user_id = ${req.userId}
        AND t.section = ${req.section}
        AND t.is_backtest = false
        AND t.status <> 'open'
        AND t.pnl IS NOT NULL
      GROUP BY t.strategy_id
    `);

    const perfMap = new Map<string, any>();
    for (const row of (perfRows as any).rows ?? perfRows) {
      perfMap.set(row.strategy_id, row);
    }

    const strategies = ALL_STRATEGIES.map((s) => {
      const config = configs.get(s.strategyId) ?? {
        strategyId: s.strategyId,
        ...(DEFAULT_STRATEGY_CONFIGS[s.strategyId] ?? {}),
      };
      const perf = perfMap.get(s.strategyId);
      const total = perf?.total_trades ?? 0;
      const wins = perf?.winning_trades ?? 0;

      return {
        strategyId: s.strategyId,
        strategyName: s.strategyName,
        supportedRegimes: s.supportedRegimes,
        // What this brain reads — shown as chips on the Strategies page.
        indicators: s.indicators,
        // True when the strategy is a native decision-maker (owns its full
        // TradePlan: leverage, structural stop, duration, reasoning).
        decisionMaker: typeof (s as { decide?: unknown }).decide === "function",
        config,
        performance: {
          totalTrades: total,
          winningTrades: wins,
          losingTrades: perf?.losing_trades ?? 0,
          winRate: total > 0 ? wins / total : null,
          totalPnl: perf?.total_pnl ?? 0,
          avgWin: perf?.avg_win ?? 0,
          avgLoss: perf?.avg_loss ?? 0,
          avgDurationSeconds: perf?.avg_duration_seconds ?? 0,
        },
      };
    });

    res.json(strategies);
  } catch (err) {
    logger.error({ err }, "GET /strategies failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /strategies/signals  — live opportunity rankings from scanner
// ---------------------------------------------------------------------------

router.get("/strategies/signals", (req, res) => {
  try {
    const scannerRows = getOrCreateEngine(req.userId!, req.section!).getScannerData();
    // Return scanner data enriched with strategy info, sorted by confidence
    const signals = scannerRows
      .filter((r) => r.strategyId)
      .map((r) => ({
        symbol: r.symbol,
        strategyId: r.strategyId,
        strategyName: r.strategyName,
        confidence: r.confidence,
        regime: r.regime,
        lastPrice: r.lastPrice,
        adx: r.adx,
        rsi: r.rsi,
        volumeRatio: r.volumeRatio,
        status: r.status,
        entryReason: r.entryReason,
      }))
      .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));

    res.json(signals);
  } catch (err) {
    logger.error({ err }, "GET /strategies/signals failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// PUT /strategies/:id  — update strategy config
// ---------------------------------------------------------------------------

router.put("/strategies/:id", async (req, res) => {
  const strategyId = req.params.id;

  // Validate strategy exists
  const strategy = ALL_STRATEGIES.find((s) => s.strategyId === strategyId);
  if (!strategy) {
    return res.status(404).json({ error: `Strategy '${strategyId}' not found` });
  }

  const b = req.body as Record<string, unknown>;

  // Phase 5B: previously this handler only coerced types (Number()/String())
  // with no bounds at all — e.g. takeProfitPercent: 0 or -5 would be written
  // straight to the DB. The only thing that caught it was botEngine's
  // post-fill safety guard, AFTER a real buy order had already filled. This
  // rejects the request up front instead.
  const numField = (key: string, min: number, max: number, label: string): string | null => {
    if (b[key] === undefined) return null;
    const n = Number(b[key]);
    if (!Number.isFinite(n) || n < min || n > max) {
      return `${label} must be a number between ${min} and ${max} (got ${JSON.stringify(b[key])})`;
    }
    return null;
  };
  // Dollar trade plan: numbers validate against bounds; explicit null CLEARS
  // the field (strategy falls back to legacy %-based behavior).
  const nullableNumField = (key: string, min: number, max: number, label: string): string | null => {
    if (b[key] === undefined || b[key] === null) return null;
    return numField(key, min, max, label);
  };
  const validationErrors = [
    nullableNumField("tradeAmountUsdt", 1, 1_000_000, "tradeAmountUsdt"),
    nullableNumField("maxLossUsdt", 0.01, 1_000_000, "maxLossUsdt"),
    nullableNumField("targetProfitUsdt", 0.01, 1_000_000, "targetProfitUsdt"),
    numField("riskPercent", 0.01, 10, "riskPercent"),
    numField("confidenceThreshold", 0, 100, "confidenceThreshold"),
    numField("stopLossPercent", 0.01, 20, "stopLossPercent"),
    // Phase 6 audit Finding B fix: a takeProfitPercent below round-trip
    // trading costs (fees + slippage, ~0.3% at default rates) is not
    // "aggressive" — it's a guaranteed net loss on every winning trade,
    // confirmed empirically (bt6 in the audit: 30/30 take-profit exits were
    // net losers, fees alone exceeded the realized move). See tradingCosts.ts.
    numField("takeProfitPercent", MIN_VIABLE_TAKE_PROFIT_PERCENT, 100, "takeProfitPercent (must clear round-trip trading costs)"),
    numField("maxHoldingSeconds", 1, 30 * 24 * 60 * 60, "maxHoldingSeconds"),
    numField("maxConcurrentPositions", 1, 20, "maxConcurrentPositions"),
    numField("cooldownMinutes", 0, 24 * 60, "cooldownMinutes"),
    numField("breakEvenRMultiple", 0, 20, "breakEvenRMultiple"),
    // 0 is legitimate: it disables TP1 (single-TP behavior) — see StrategyConfig.
    numField("tp1RMultiple", 0, 20, "tp1RMultiple"),
    numField("tp2RMultiple", 0.01, 20, "tp2RMultiple"),
    numField("tp3RMultiple", 0.01, 20, "tp3RMultiple"),
    numField("tp1ClosePercent", 0, 100, "tp1ClosePercent"),
    numField("tp2ClosePercent", 0, 100, "tp2ClosePercent"),
    numField("trailingStopAtrMultiplier", 0.01, 20, "trailingStopAtrMultiplier"),
    numField("trailingStopPercent", 0.01, 20, "trailingStopPercent"),
    numField("emergencyTrailingRMultiple", 0, 20, "emergencyTrailingRMultiple"),
    numField("emergencyTrailingPercent", 0.01, 20, "emergencyTrailingPercent"),
  ].filter((e): e is string => e !== null);

  if (validationErrors.length > 0) {
    return res.status(400).json({ error: "Invalid strategy configuration", details: validationErrors });
  }

  try {
    const d = DEFAULT_STRATEGY_CONFIGS[strategyId] ?? {
      enabled: true, riskPercent: 1.0, confidenceThreshold: 65,
      stopLossPercent: 1.5, takeProfitPercent: 2.5,
      maxHoldingSeconds: 3600, maxConcurrentPositions: 2, cooldownMinutes: 30,
      tp1RMultiple: 1.0, tp1ClosePercent: 50,
      tp3Enabled: false, tp2RMultiple: 2.0, tp2ClosePercent: 25, tp3RMultiple: 4.0,
      trailingStopMode: "none" as const, trailingStopAtrMultiplier: 1.5, trailingStopPercent: 1.0,
      trailingAfterTp1Only: true, emergencyTrailingRMultiple: 0, emergencyTrailingPercent: 0.5,
      exitPriority: ["stop_loss", "take_profit", "trailing_stop", "timeout"],
    };
    const VALID_TRAILING_MODES = new Set(["none", "atr", "percent", "dynamic"]);
    const VALID_PRIORITY_KEYS = new Set(["stop_loss", "take_profit", "trailing_stop", "timeout"]);
    const trailingStopMode =
      typeof b.trailingStopMode === "string" && VALID_TRAILING_MODES.has(b.trailingStopMode)
        ? b.trailingStopMode : d.trailingStopMode;
    const exitPriority = Array.isArray(b.exitPriority)
      ? (b.exitPriority as unknown[]).map(String).filter((k) => VALID_PRIORITY_KEYS.has(k))
      : d.exitPriority;

    const [updated] = await db
      .insert(strategyConfigsTable)
      .values({
        userId: req.userId!,
        section: req.section!,
        strategyId,
        strategyName: strategy.strategyName,
        enabled:                b.enabled                !== undefined ? Boolean(b.enabled) : d.enabled,
        tradeAmountUsdt:        b.tradeAmountUsdt  !== undefined ? (b.tradeAmountUsdt  === null ? null : String(b.tradeAmountUsdt))  : null,
        maxLossUsdt:            b.maxLossUsdt      !== undefined ? (b.maxLossUsdt      === null ? null : String(b.maxLossUsdt))      : null,
        targetProfitUsdt:       b.targetProfitUsdt !== undefined ? (b.targetProfitUsdt === null ? null : String(b.targetProfitUsdt)) : null,
        riskPercent:            String(b.riskPercent            ?? d.riskPercent),
        confidenceThreshold:    Number(b.confidenceThreshold    ?? d.confidenceThreshold),
        stopLossPercent:        String(b.stopLossPercent        ?? d.stopLossPercent),
        takeProfitPercent:      String(b.takeProfitPercent      ?? d.takeProfitPercent),
        maxHoldingSeconds:      Number(b.maxHoldingSeconds      ?? d.maxHoldingSeconds),
        maxConcurrentPositions: Number(b.maxConcurrentPositions ?? d.maxConcurrentPositions),
        cooldownMinutes:        Number(b.cooldownMinutes        ?? d.cooldownMinutes),
        breakEvenRMultiple:          String(b.breakEvenRMultiple          ?? d.breakEvenRMultiple),
        tp1RMultiple:                String(b.tp1RMultiple                ?? d.tp1RMultiple),
        tp1ClosePercent:              Number(b.tp1ClosePercent              ?? d.tp1ClosePercent),
        tp3Enabled:                   b.tp3Enabled                !== undefined ? Boolean(b.tp3Enabled) : d.tp3Enabled,
        tp2RMultiple:                 String(b.tp2RMultiple                ?? d.tp2RMultiple),
        tp2ClosePercent:              Number(b.tp2ClosePercent              ?? d.tp2ClosePercent),
        tp3RMultiple:                 String(b.tp3RMultiple                ?? d.tp3RMultiple),
        trailingStopMode,
        trailingStopAtrMultiplier:    String(b.trailingStopAtrMultiplier    ?? d.trailingStopAtrMultiplier),
        trailingStopPercent:          String(b.trailingStopPercent          ?? d.trailingStopPercent),
        trailingAfterTp1Only:         b.trailingAfterTp1Only     !== undefined ? Boolean(b.trailingAfterTp1Only) : d.trailingAfterTp1Only,
        emergencyTrailingRMultiple:   String(b.emergencyTrailingRMultiple   ?? d.emergencyTrailingRMultiple),
        emergencyTrailingPercent:     String(b.emergencyTrailingPercent     ?? d.emergencyTrailingPercent),
        exitPriority: exitPriority.join(","),
      })
      .onConflictDoUpdate({
        target: [strategyConfigsTable.userId, strategyConfigsTable.section, strategyConfigsTable.strategyId],
        set: {
          enabled:                b.enabled                !== undefined ? Boolean(b.enabled) : undefined,
          tradeAmountUsdt:        b.tradeAmountUsdt  !== undefined ? (b.tradeAmountUsdt  === null ? null : String(b.tradeAmountUsdt))  : undefined,
          maxLossUsdt:            b.maxLossUsdt      !== undefined ? (b.maxLossUsdt      === null ? null : String(b.maxLossUsdt))      : undefined,
          targetProfitUsdt:       b.targetProfitUsdt !== undefined ? (b.targetProfitUsdt === null ? null : String(b.targetProfitUsdt)) : undefined,
          riskPercent:            b.riskPercent            !== undefined ? String(b.riskPercent) : undefined,
          confidenceThreshold:    b.confidenceThreshold    !== undefined ? Number(b.confidenceThreshold) : undefined,
          stopLossPercent:        b.stopLossPercent        !== undefined ? String(b.stopLossPercent) : undefined,
          takeProfitPercent:      b.takeProfitPercent      !== undefined ? String(b.takeProfitPercent) : undefined,
          maxHoldingSeconds:      b.maxHoldingSeconds      !== undefined ? Number(b.maxHoldingSeconds) : undefined,
          maxConcurrentPositions: b.maxConcurrentPositions !== undefined ? Number(b.maxConcurrentPositions) : undefined,
          cooldownMinutes:        b.cooldownMinutes        !== undefined ? Number(b.cooldownMinutes) : undefined,
          breakEvenRMultiple:           b.breakEvenRMultiple           !== undefined ? String(b.breakEvenRMultiple) : undefined,
          tp1RMultiple:                 b.tp1RMultiple                !== undefined ? String(b.tp1RMultiple) : undefined,
          tp1ClosePercent:              b.tp1ClosePercent              !== undefined ? Number(b.tp1ClosePercent) : undefined,
          tp3Enabled:                   b.tp3Enabled                   !== undefined ? Boolean(b.tp3Enabled) : undefined,
          tp2RMultiple:                 b.tp2RMultiple                 !== undefined ? String(b.tp2RMultiple) : undefined,
          tp2ClosePercent:              b.tp2ClosePercent              !== undefined ? Number(b.tp2ClosePercent) : undefined,
          tp3RMultiple:                 b.tp3RMultiple                 !== undefined ? String(b.tp3RMultiple) : undefined,
          trailingStopMode:             b.trailingStopMode             !== undefined ? trailingStopMode : undefined,
          trailingStopAtrMultiplier:    b.trailingStopAtrMultiplier    !== undefined ? String(b.trailingStopAtrMultiplier) : undefined,
          trailingStopPercent:          b.trailingStopPercent          !== undefined ? String(b.trailingStopPercent) : undefined,
          trailingAfterTp1Only:         b.trailingAfterTp1Only         !== undefined ? Boolean(b.trailingAfterTp1Only) : undefined,
          emergencyTrailingRMultiple:   b.emergencyTrailingRMultiple   !== undefined ? String(b.emergencyTrailingRMultiple) : undefined,
          emergencyTrailingPercent:     b.emergencyTrailingPercent     !== undefined ? String(b.emergencyTrailingPercent) : undefined,
          exitPriority:                 b.exitPriority                 !== undefined ? exitPriority.join(",") : undefined,
        },
      })
      .returning();

    return res.json({ success: true, strategyId, config: updated });
  } catch (err) {
    logger.error({ err, strategyId }, "PUT /strategies/:id failed");
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
