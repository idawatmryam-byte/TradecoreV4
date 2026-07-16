/**
 * Strategy Config Loader
 *
 * Loads per-strategy configuration from the strategy_configs DB table.
 * Falls back to DEFAULT_STRATEGY_CONFIGS for any strategy not yet in DB,
 * and upserts the defaults so they appear in the UI immediately.
 */
import { db } from "@workspace/db";
import { strategyConfigsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { type StrategyConfig, DEFAULT_STRATEGY_CONFIGS, ALL_STRATEGIES } from "./strategies";
import { logger } from "./logger";

/**
 * Load all strategy configs for one user from DB, seeding defaults for any
 * missing entries. Returns a Map<strategyId, StrategyConfig>.
 */
export async function loadStrategyConfigs(userId: number): Promise<Map<string, StrategyConfig>> {
  try {
    // Upsert defaults for each known strategy so they always exist in DB
    for (const strategy of ALL_STRATEGIES) {
      const defaults = DEFAULT_STRATEGY_CONFIGS[strategy.strategyId];
      if (!defaults) continue;
      await db
        .insert(strategyConfigsTable)
        .values({
          userId,
          strategyId: strategy.strategyId,
          strategyName: strategy.strategyName,
          enabled: defaults.enabled,
          tradeAmountUsdt: defaults.tradeAmountUsdt != null ? String(defaults.tradeAmountUsdt) : null,
          maxLossUsdt: defaults.maxLossUsdt != null ? String(defaults.maxLossUsdt) : null,
          targetProfitUsdt: defaults.targetProfitUsdt != null ? String(defaults.targetProfitUsdt) : null,
          riskPercent: String(defaults.riskPercent),
          confidenceThreshold: defaults.confidenceThreshold,
          stopLossPercent: String(defaults.stopLossPercent),
          takeProfitPercent: String(defaults.takeProfitPercent),
          maxHoldingSeconds: defaults.maxHoldingSeconds,
          maxConcurrentPositions: defaults.maxConcurrentPositions,
          cooldownMinutes: defaults.cooldownMinutes,
          tp1RMultiple: String(defaults.tp1RMultiple),
          tp1ClosePercent: defaults.tp1ClosePercent,
          tp3Enabled: defaults.tp3Enabled,
          tp2RMultiple: String(defaults.tp2RMultiple),
          tp2ClosePercent: defaults.tp2ClosePercent,
          tp3RMultiple: String(defaults.tp3RMultiple),
          trailingStopMode: defaults.trailingStopMode,
          trailingStopAtrMultiplier: String(defaults.trailingStopAtrMultiplier),
          trailingStopPercent: String(defaults.trailingStopPercent),
          trailingAfterTp1Only: defaults.trailingAfterTp1Only,
          emergencyTrailingRMultiple: String(defaults.emergencyTrailingRMultiple),
          emergencyTrailingPercent: String(defaults.emergencyTrailingPercent),
          exitPriority: defaults.exitPriority.join(","),
        })
        .onConflictDoNothing({
          target: [strategyConfigsTable.userId, strategyConfigsTable.strategyId],
        }); // don't overwrite user-edited values
    }
  } catch (err) {
    logger.warn({ err }, "Strategy config upsert failed (non-fatal)");
  }

  const rows = await db.select().from(strategyConfigsTable).where(eq(strategyConfigsTable.userId, userId));
  const map = new Map<string, StrategyConfig>();

  const VALID_PRIORITY_KEYS = new Set(["stop_loss", "take_profit", "trailing_stop", "timeout"]);
  function parseExitPriority(raw: string): string[] {
    const parsed = raw.split(",").map((s) => s.trim()).filter((s) => VALID_PRIORITY_KEYS.has(s));
    // Fall back to the safe default order if the stored value is empty/corrupt,
    // and always guarantee stop_loss is checked first regardless of config —
    // capital protection takes priority over any configured ordering.
    const deduped = [...new Set(parsed.length > 0 ? parsed : ["stop_loss", "take_profit", "trailing_stop", "timeout"])];
    if (deduped[0] !== "stop_loss") {
      return ["stop_loss", ...deduped.filter((k) => k !== "stop_loss")];
    }
    return deduped;
  }

  for (const row of rows) {
    map.set(row.strategyId, {
      strategyId: row.strategyId,
      enabled: row.enabled,
      tradeAmountUsdt: row.tradeAmountUsdt != null ? Number(row.tradeAmountUsdt) : null,
      maxLossUsdt: row.maxLossUsdt != null ? Number(row.maxLossUsdt) : null,
      targetProfitUsdt: row.targetProfitUsdt != null ? Number(row.targetProfitUsdt) : null,
      riskPercent: Number(row.riskPercent),
      confidenceThreshold: row.confidenceThreshold,
      stopLossPercent: Number(row.stopLossPercent),
      takeProfitPercent: Number(row.takeProfitPercent),
      maxHoldingSeconds: row.maxHoldingSeconds,
      maxConcurrentPositions: row.maxConcurrentPositions,
      cooldownMinutes: row.cooldownMinutes,
      tp1RMultiple: Number(row.tp1RMultiple),
      tp1ClosePercent: row.tp1ClosePercent,
      tp3Enabled: row.tp3Enabled,
      tp2RMultiple: Number(row.tp2RMultiple),
      tp2ClosePercent: row.tp2ClosePercent,
      tp3RMultiple: Number(row.tp3RMultiple),
      trailingStopMode: (["none", "atr", "percent", "dynamic"] as const).includes(row.trailingStopMode as any)
        ? (row.trailingStopMode as StrategyConfig["trailingStopMode"])
        : "none",
      trailingStopAtrMultiplier: Number(row.trailingStopAtrMultiplier),
      trailingStopPercent: Number(row.trailingStopPercent),
      trailingAfterTp1Only: row.trailingAfterTp1Only,
      emergencyTrailingRMultiple: Number(row.emergencyTrailingRMultiple),
      emergencyTrailingPercent: Number(row.emergencyTrailingPercent),
      exitPriority: parseExitPriority(row.exitPriority),
    });
  }

  // Fill in any strategies not in DB with defaults (should not happen after upsert)
  for (const strategy of ALL_STRATEGIES) {
    if (!map.has(strategy.strategyId)) {
      const d = DEFAULT_STRATEGY_CONFIGS[strategy.strategyId];
      if (d) map.set(strategy.strategyId, { strategyId: strategy.strategyId, ...d });
    }
  }

  return map;
}
