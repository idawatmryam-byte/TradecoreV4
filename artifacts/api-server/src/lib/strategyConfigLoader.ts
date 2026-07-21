/**
 * Strategy Config Loader
 *
 * Loads per-strategy configuration from the strategy_configs DB table.
 * Falls back to DEFAULT_STRATEGY_CONFIGS for any strategy not yet in DB,
 * and upserts the defaults so they appear in the UI immediately.
 */
import { db } from "@workspace/db";
import { strategyConfigsTable, customStrategiesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { type StrategyConfig, DEFAULT_STRATEGY_CONFIGS, CRYPTO_STRATEGIES, strategiesForSection } from "./strategies";
import { logger } from "./logger";
import type { Section } from "./engineRegistry";
import { DEFAULT_CUSTOM_STRATEGY_CONFIG } from "./strategies/custom";

/**
 * Load all strategy configs for one (user, section) from DB, seeding defaults
 * for any missing entries. Returns a Map<strategyId, StrategyConfig>. Crypto
 * and forex keep completely separate strategy tuning.
 */
export async function loadStrategyConfigs(
  userId: number,
  section: Section = "crypto",
): Promise<Map<string, StrategyConfig>> {
  // Crypto and forex trade different books (see CRYPTO_STRATEGIES /
  // FOREX_STRATEGIES in strategies/index.ts) — every step below (seeding,
  // row filtering, default fill) operates on THIS SECTION'S catalog only.
  const catalog = strategiesForSection(section);
  const catalogIds = new Set<string>(catalog.map((s) => s.strategyId));

  // The user's CUSTOM strategies count as catalog members too — their config
  // rows (same table, same shape) must survive the section filter below and
  // get a conservative default when missing. Failure is non-fatal: built-ins
  // must keep loading even if the custom table is unreachable.
  let customIds: string[] = [];
  try {
    const customRows = await db
      .select({ strategyId: customStrategiesTable.strategyId })
      .from(customStrategiesTable)
      .where(and(eq(customStrategiesTable.userId, userId), eq(customStrategiesTable.section, section)));
    customIds = customRows.map((r) => r.strategyId).filter((id) => id.length > 0);
    for (const id of customIds) catalogIds.add(id);
  } catch (err) {
    logger.warn({ err, userId, section }, "Custom strategy id lookup failed (non-fatal) — configs load built-ins only");
  }

  try {
    // Upsert defaults for each strategy in the section's catalog so they
    // always exist in DB.
    for (const strategy of catalog) {
      let defaults = DEFAULT_STRATEGY_CONFIGS[strategy.strategyId];
      if (!defaults) continue;
      // Forex seeds get FX-appropriate dollar plans. The crypto defaults
      // (e.g. risk $40 → make $80 on $300 notional) imply double-digit-%
      // price moves — EUR/USD moves ~0.5% a DAY, so those targets are
      // unreachable and the section would never trade (observed live:
      // "target 15% unreachable at any leverage" on every scan). FX gets
      // big notional + small % targets + slower holds instead. Only
      // affects NEW rows — existing user-edited configs are never touched.
      // FX-NATIVE strategies (in the forex catalog only) already ship
      // FX-scale defaults — they seed as written.
      const sharedFromCrypto = CRYPTO_STRATEGIES.some((s) => s.strategyId === strategy.strategyId);
      if (section === "forex" && sharedFromCrypto) {
        defaults = {
          ...defaults,
          tradeAmountUsdt: 5000,
          maxLossUsdt: 10,
          targetProfitUsdt: 12,
          maxHoldingSeconds: Math.min(defaults.maxHoldingSeconds * 4, 8 * 3600),
        };
      }
      await db
        .insert(strategyConfigsTable)
        .values({
          userId,
          section,
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
          breakEvenRMultiple: String(defaults.breakEvenRMultiple),
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
          target: [strategyConfigsTable.userId, strategyConfigsTable.section, strategyConfigsTable.strategyId],
        }); // don't overwrite user-edited values
    }
  } catch (err) {
    logger.warn({ err }, "Strategy config upsert failed (non-fatal)");
  }

  const rows = await db
    .select()
    .from(strategyConfigsTable)
    .where(and(eq(strategyConfigsTable.userId, userId), eq(strategyConfigsTable.section, section)));

  // Self-heal FOREX rows that predate the FX-appropriate seeds above: a row
  // whose dollar plan still EXACTLY equals the crypto default for its
  // strategy was never adapted for forex (observed live as "target 15.02%
  // unreachable" on every scan — 45/300 is a crypto-scale plan). Rows the
  // user has edited never match the crypto defaults and are left alone.
  if (section === "forex") {
    const sameNum = (a: string | null, b: number | null) =>
      (a == null && b == null) || (a != null && b != null && Number(a) === b);
    for (const row of rows) {
      const crypto = DEFAULT_STRATEGY_CONFIGS[row.strategyId];
      if (!crypto) continue;
      // Rows already carrying the FX seed values need no healing (and
      // FX-native strategies ship those values as their crypto "defaults",
      // which would otherwise re-trigger this every load).
      if (sameNum(row.tradeAmountUsdt, 5000) && sameNum(row.maxLossUsdt, 10) && sameNum(row.targetProfitUsdt, 12)) continue;
      const stale =
        sameNum(row.tradeAmountUsdt, crypto.tradeAmountUsdt) &&
        sameNum(row.maxLossUsdt, crypto.maxLossUsdt) &&
        sameNum(row.targetProfitUsdt, crypto.targetProfitUsdt);
      if (!stale) continue;
      const fxHolding =
        row.maxHoldingSeconds === crypto.maxHoldingSeconds
          ? Math.min(crypto.maxHoldingSeconds * 4, 8 * 3600)
          : row.maxHoldingSeconds;
      try {
        await db
          .update(strategyConfigsTable)
          .set({
            tradeAmountUsdt: "5000",
            maxLossUsdt: "10",
            targetProfitUsdt: "12",
            maxHoldingSeconds: fxHolding,
          })
          .where(
            and(
              eq(strategyConfigsTable.userId, userId),
              eq(strategyConfigsTable.section, section),
              eq(strategyConfigsTable.strategyId, row.strategyId),
            ),
          );
        row.tradeAmountUsdt = "5000";
        row.maxLossUsdt = "10";
        row.targetProfitUsdt = "12";
        row.maxHoldingSeconds = fxHolding;
        logger.info(
          { userId, strategyId: row.strategyId },
          "Migrated stale crypto-default dollar plan on forex strategy config to FX seeds (5000/10/12)",
        );
      } catch (err) {
        logger.warn({ err, strategyId: row.strategyId }, "Forex config self-heal failed (non-fatal)");
      }
    }
  }

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
    // Rows for strategies outside this section's catalog are ignored (e.g.
    // crypto scalpers' old rows in the forex section after the catalogs
    // split) — the data stays in DB but never loads or trades.
    if (!catalogIds.has(row.strategyId)) continue;
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
      breakEvenRMultiple: Number(row.breakEvenRMultiple),
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

  // Fill in any catalog strategies not in DB with defaults (should not
  // happen after upsert)
  for (const strategy of catalog) {
    if (!map.has(strategy.strategyId)) {
      const d = DEFAULT_STRATEGY_CONFIGS[strategy.strategyId];
      if (d) map.set(strategy.strategyId, { strategyId: strategy.strategyId, ...d });
    }
  }

  // Same safety net for custom strategies missing a config row (the create
  // route seeds one; this covers rows created out-of-band): disabled + no
  // dollar plan, so nothing trades until the user configures it.
  for (const id of customIds) {
    if (!map.has(id)) map.set(id, { strategyId: id, ...DEFAULT_CUSTOM_STRATEGY_CONFIG });
  }

  return map;
}
