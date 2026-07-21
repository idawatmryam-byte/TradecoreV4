/**
 * Custom Strategy Loader — turns a user's custom_strategies rows into live
 * CustomStrategy instances for the selector.
 *
 * Rules are re-validated on load (defense in depth: the API validates on
 * write, but a row edited out-of-band must never crash the scan loop — an
 * invalid row is skipped with a warning). Results are cached per
 * (user, section) with a short TTL, mirroring the strategy-config cache in
 * botEngine, so the scan loop does no per-tick DB work.
 */
import { db } from "@workspace/db";
import { customStrategiesTable, type CustomStrategyRow } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { CustomStrategy } from "./strategies/custom";
import { parseCustomRules, MAX_CUSTOM_STRATEGIES } from "./customRules";
import type { Section } from "./engineRegistry";
import { logger } from "./logger";

export interface LoadedCustomStrategy {
  strategy: CustomStrategy;
  row: CustomStrategyRow;
}

const cache = new Map<string, { at: number; loaded: LoadedCustomStrategy[] }>();
const CACHE_TTL_MS = 60_000;

/** Drop the cached list for one (user, section) — call after any CRUD write
 *  so the next scan/backtest sees the change immediately. */
export function invalidateCustomStrategies(userId: number, section: Section): void {
  cache.delete(`${userId}:${section}`);
}

/** All valid custom strategies for (user, section), newest-created last. */
export async function loadCustomStrategies(userId: number, section: Section): Promise<LoadedCustomStrategy[]> {
  const key = `${userId}:${section}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.loaded;

  const rows = await db
    .select()
    .from(customStrategiesTable)
    .where(and(eq(customStrategiesTable.userId, userId), eq(customStrategiesTable.section, section)))
    .orderBy(customStrategiesTable.id)
    .limit(MAX_CUSTOM_STRATEGIES);

  const loaded: LoadedCustomStrategy[] = [];
  for (const row of rows) {
    try {
      const rules = parseCustomRules(row.rules);
      loaded.push({ strategy: new CustomStrategy(row.strategyId, row.name, rules), row });
    } catch (err) {
      logger.warn({ err, userId, section, strategyId: row.strategyId }, "Custom strategy has invalid rules — skipped");
    }
  }
  cache.set(key, { at: Date.now(), loaded });
  return loaded;
}

/** The custom strategies allowed to trade LIVE: enabled is governed by the
 *  strategy_configs row like every built-in; this adds the backtest-first
 *  gate — a strategy whose rules have never completed a backtest (or were
 *  edited since) never reaches the live selector. */
export function liveEligible(loaded: LoadedCustomStrategy[]): LoadedCustomStrategy[] {
  return loaded.filter((l) => l.row.lastBacktestAt != null);
}
