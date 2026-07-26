/**
 * TradeCore Pro — knowledge service (the DB half)
 *
 * Turns the trade log into the `TradeObservation` record the pure knowledge
 * core consumes, and nothing more. The statistics live in cells.ts,
 * calibration.ts and similarity.ts, all of which are pure and testable without
 * a database; this file is the only part that knows what a table is.
 *
 * Two loading decisions worth stating outright:
 *
 *  DEMO AND LIVE ARE NEVER MIXED. A demo win rate presented as a live one is
 *  a lie, and a pooled one is a subtler lie that cannot be unmixed by the
 *  reader. Observations are always loaded for one execution target, defaulting
 *  to whichever the section is currently configured for — so the knowledge you
 *  see describes the account you are actually running.
 *
 *  FEATURES COME FROM CAPTURE, NOT FROM THE TRADE ROW. The indicator readings
 *  behind a decision live in `capture.feature_snapshots`, joined through the
 *  correlation ID stamped at the execution seam in P1. Trades that predate
 *  capture simply have no feature vector — they still count in every cell, and
 *  are absent only from the similarity pool, which is the honest treatment.
 */
import {
  db, tradesTable, botConfigTable, capturedDecisionsTable, featureSnapshotsTable,
} from "@workspace/db";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { plannedRiskDollars } from "../metrics/kernel";
import { logger } from "../logger";
import { asOfView, type PointInTimeView } from "./pointInTime";
import { buildKnowledge, type CellsOptions, type KnowledgeReport, type TradeObservation } from "./cells";
import { calibrationReport, type CalibrationOptions, type CalibrationReport } from "./calibration";
import { findSimilarTrades, FEATURE_KEYS, type FeatureVector, type SimilarOptions, type SimilarTradesResult } from "./similarity";
import type { Section } from "../engineRegistry";

/**
 * How many closed trades feed the knowledge layer.
 *
 * Bounded because these are read-model queries on an interactive request; an
 * account with years of history should not pay for all of it to render a
 * dashboard card. Newest-first, so the cap drops the least relevant rows.
 */
export const OBSERVATION_LIMIT = 5000;

export type ExecutionTarget = "demo" | "live";

/** Whichever target this section is currently trading. */
export async function currentExecutionTarget(userId: number, section: Section): Promise<ExecutionTarget> {
  const [cfg] = await db
    .select({ target: botConfigTable.executionTarget })
    .from(botConfigTable)
    .where(and(eq(botConfigTable.userId, userId), eq(botConfigTable.section, section)))
    .limit(1);
  return cfg?.target === "demo" ? "demo" : "live";
}

/** Pull the similarity features out of a stored SignalRow, dropping anything unusable. */
export function featuresFromSnapshot(raw: unknown): FeatureVector | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const key of FEATURE_KEYS) {
    const v = row[key];
    if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

interface LoadOptions {
  executionTarget?: ExecutionTarget;
  limit?: number;
  /** The cut. Defaults to now — a live screen asks "what is knowable today?". */
  asOf?: Date;
}

/**
 * Load closed trades as point-in-time observations.
 *
 * The left join is to capture, so a missing snapshot costs the trade its
 * feature vector and nothing else. Rows are deduplicated by trade id: a
 * correlation ID should map to exactly one captured decision, but a join that
 * silently double-counts a trade would inflate every sample count downstream,
 * which is the one failure this layer cannot be allowed to have.
 */
export async function loadObservations(
  userId: number,
  section: Section,
  opts: LoadOptions = {},
): Promise<PointInTimeView<TradeObservation>> {
  const asOf = opts.asOf ?? new Date();
  const target = opts.executionTarget ?? (await currentExecutionTarget(userId, section));

  const rows = await db
    .select({
      id: tradesTable.id,
      symbol: tradesTable.symbol,
      strategyId: tradesTable.strategyId,
      entryPrice: tradesTable.entryPrice,
      stopLoss: tradesTable.stopLoss,
      quantity: tradesTable.quantity,
      pnl: tradesTable.pnl,
      confidence: tradesTable.confidence,
      exitReason: tradesTable.exitReason,
      entryTime: tradesTable.entryTime,
      exitTime: tradesTable.exitTime,
      tradePlan: tradesTable.tradePlan,
      features: featureSnapshotsTable.features,
    })
    .from(tradesTable)
    .leftJoin(capturedDecisionsTable, and(
      isNotNull(tradesTable.correlationId),
      eq(capturedDecisionsTable.correlationId, tradesTable.correlationId),
      eq(capturedDecisionsTable.outcome, "executed"),
    ))
    .leftJoin(featureSnapshotsTable, eq(featureSnapshotsTable.id, capturedDecisionsTable.featureSnapshotId))
    .where(and(
      eq(tradesTable.userId, userId),
      eq(tradesTable.section, section),
      eq(tradesTable.status, "closed"),
      eq(tradesTable.isBacktest, false),
      eq(tradesTable.executionTarget, target),
      isNotNull(tradesTable.exitTime),
      isNotNull(tradesTable.pnl),
      sql`${tradesTable.exitTime} <= ${asOf}`,
    ))
    .orderBy(desc(tradesTable.exitTime))
    .limit(opts.limit ?? OBSERVATION_LIMIT);

  const seen = new Set<number>();
  const observations: TradeObservation[] = [];

  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);

    const entryPrice = Number(r.entryPrice);
    const features = featuresFromSnapshot(r.features);
    const plan = (r.tradePlan ?? null) as { regime?: unknown } | null;
    const regime = typeof plan?.regime === "string" ? plan.regime : null;

    observations.push({
      tradeId: r.id,
      closedAt: r.exitTime!.getTime(),
      entryTime: r.entryTime.getTime(),
      symbol: r.symbol,
      strategyId: r.strategyId,
      regime,
      atrPercent: features?.atrPercent ?? null,
      pnl: Number(r.pnl),
      plannedRisk: plannedRiskDollars(entryPrice, Number(r.stopLoss), Number(r.quantity)),
      exitReason: r.exitReason,
      confidence: r.confidence != null ? Number(r.confidence) : null,
      features,
    });
  }

  // asOfView re-applies the cut the SQL already made. Redundant on purpose:
  // it is what produces the PointInTimeView, and it means the guarantee holds
  // even if this query is ever edited into something looser.
  return asOfView(observations, asOf);
}

export interface KnowledgeOverview {
  executionTarget: ExecutionTarget;
  knowledge: KnowledgeReport;
  calibration: CalibrationReport;
}

/** Cells + calibration for one section, both as of the same moment. */
export async function knowledgeOverview(
  userId: number,
  section: Section,
  opts: LoadOptions & CellsOptions & CalibrationOptions = {},
): Promise<KnowledgeOverview> {
  const executionTarget = opts.executionTarget ?? (await currentExecutionTarget(userId, section));
  const view = await loadObservations(userId, section, { ...opts, executionTarget });
  return {
    executionTarget,
    knowledge: buildKnowledge(view, opts),
    calibration: calibrationReport(view, opts),
  };
}

/**
 * Similar closed trades for a live candidate.
 *
 * Best-effort by design: this decorates a recommendation, and a knowledge
 * query failing must never be the reason a plan cannot be reviewed. On error
 * it returns the same shape the gates return, so the caller has one path.
 */
export async function similarTradesFor(
  userId: number,
  section: Section,
  candidate: FeatureVector,
  opts: LoadOptions & SimilarOptions = {},
): Promise<SimilarTradesResult> {
  try {
    const view = await loadObservations(userId, section, opts);
    return findSimilarTrades(candidate, view, opts);
  } catch (err) {
    logger.warn({ err, userId, section }, "KNOWLEDGE_SIMILAR_FAILED");
    return {
      available: false,
      reason: "Similar-trade analysis is temporarily unavailable.",
      poolSize: 0,
      minPoolSize: opts.minPoolSize ?? 30,
      similarityFloor: opts.similarityFloor ?? 0.7,
      matches: [],
      stats: null,
      featuresUsed: [],
    };
  }
}
