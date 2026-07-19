/**
 * TradeCore Pro — Decision journal persistence
 *
 * Writes every genuinely-considered trade decision (executed / approved but
 * not taken / rejected with reasoning) into strategy_decisions, the durable
 * journal behind the Decisions feed.
 *
 * Two rules keep the table bounded — they are load-bearing, not cosmetic:
 *   • DEDUPE: the same strategy rejecting the same symbol for the same reason
 *     every 15s scan would add ~5.7k rows/day. Instead, an identical decision
 *     seen again within DEDUPE_WINDOW_MS bumps `occurrences` + `lastSeenAt`
 *     on the existing row.
 *   • RETENTION: rows older than RETENTION_DAYS are pruned (called hourly
 *     from the scan loop).
 *
 * All writes are best-effort: a decision-journal failure must never block or
 * crash the trading scan.
 */
import { db, strategyDecisionsTable } from "@workspace/db";
import { and, eq, gte, lt, sql, desc } from "drizzle-orm";
import type { TradePlan, TradeRejection } from "./strategies/base";
import type { Section } from "./engineRegistry";
import { logger } from "./logger";

const DEDUPE_WINDOW_MS = 30 * 60_000; // identical decision within 30min → bump, don't insert
const RETENTION_DAYS = 14;

export type DecisionKind = "executed" | "approved_not_taken" | "rejected";

export interface DecisionRecord {
  kind: DecisionKind;
  symbol: string;
  strategyId: string;
  strategyName: string | null;
  side: string | null;
  confidence: number | null;
  stage: string | null;
  reason: string | null;
  /** DecisionReport for rejections; the full TradePlan for approved/executed. */
  report: unknown;
  tradeId?: number | null;
}

export function rejectionToRecord(r: TradeRejection): DecisionRecord {
  return {
    kind: "rejected",
    symbol: r.symbol,
    strategyId: r.strategyId,
    strategyName: r.strategyName ?? null,
    side: r.side ?? null,
    confidence: r.confidence ?? null,
    stage: r.stage,
    reason: r.reason,
    report: r.report ?? null,
  };
}

export function planToRecord(
  plan: TradePlan,
  kind: Exclude<DecisionKind, "rejected">,
  opts: { stage?: string; reason?: string; tradeId?: number } = {},
): DecisionRecord {
  return {
    kind,
    symbol: plan.symbol,
    strategyId: plan.strategyId,
    strategyName: plan.strategyName,
    side: plan.side,
    confidence: plan.confidence,
    stage: opts.stage ?? null,
    reason: opts.reason ?? null,
    report: plan,
    tradeId: opts.tradeId ?? null,
  };
}

/**
 * Persist a batch of decisions from one scan. Executed decisions always
 * insert (each is a distinct trade); rejections/not-taken dedupe against the
 * most recent identical row inside the window.
 */
export async function recordDecisions(userId: number, decisions: DecisionRecord[], section: Section = "crypto"): Promise<void> {
  if (decisions.length === 0) return;
  const windowStart = new Date(Date.now() - DEDUPE_WINDOW_MS);

  for (const d of decisions) {
    try {
      if (d.kind !== "executed") {
        // Dedupe on the decision's SHAPE (symbol × strategy × kind × stage),
        // not the reason text — reasons embed live numbers ("target 3.33%
        // unreachable…") that change every scan, which would defeat the
        // dedupe and flood the feed with near-identical rows (observed live:
        // three ARBUSDT coin-fit cards instead of one ×3).
        const [existing] = await db
          .select({ id: strategyDecisionsTable.id })
          .from(strategyDecisionsTable)
          .where(and(
            eq(strategyDecisionsTable.userId, userId),
            eq(strategyDecisionsTable.section, section),
            eq(strategyDecisionsTable.symbol, d.symbol),
            eq(strategyDecisionsTable.strategyId, d.strategyId),
            eq(strategyDecisionsTable.kind, d.kind),
            eq(strategyDecisionsTable.stage, d.stage ?? ""),
            gte(strategyDecisionsTable.lastSeenAt, windowStart),
          ))
          .orderBy(desc(strategyDecisionsTable.lastSeenAt))
          .limit(1);

        if (existing) {
          await db
            .update(strategyDecisionsTable)
            .set({
              occurrences: sql`${strategyDecisionsTable.occurrences} + 1`,
              lastSeenAt: new Date(),
              // Keep the freshest numbers on the deduped row.
              reason: d.reason ?? undefined,
              confidence: d.confidence != null ? String(d.confidence) : undefined,
              report: d.report ?? undefined,
            })
            .where(eq(strategyDecisionsTable.id, existing.id));
          continue;
        }
      }

      await db.insert(strategyDecisionsTable).values({
        userId,
        section,
        symbol: d.symbol,
        strategyId: d.strategyId,
        strategyName: d.strategyName,
        kind: d.kind,
        side: d.side,
        confidence: d.confidence != null ? String(d.confidence) : null,
        stage: d.stage,
        reason: d.reason ?? "",
        report: d.report ?? null,
        tradeId: d.tradeId ?? null,
      });
    } catch (err) {
      logger.warn({ err, symbol: d.symbol, strategyId: d.strategyId }, "DECISION_RECORD_FAILED");
    }
  }
}

/** Delete journal rows past the retention window. Call ~hourly; best-effort. */
export async function pruneDecisions(userId: number, section: Section = "crypto"): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 3600_000);
    await db
      .delete(strategyDecisionsTable)
      .where(and(
        eq(strategyDecisionsTable.userId, userId),
        eq(strategyDecisionsTable.section, section),
        lt(strategyDecisionsTable.createdAt, cutoff),
      ));
  } catch (err) {
    logger.warn({ err }, "DECISION_PRUNE_FAILED");
  }
}
