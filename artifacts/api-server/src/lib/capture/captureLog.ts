/**
 * TradeCore Pro — capture log writer
 *
 * Writes the inputs half of the historical asset: the exact feature snapshot a
 * decision was made on, the decision itself, and the provenance to reproduce
 * it. Outcomes are already captured (trades + trade_analyses) and join back
 * through `correlationId`.
 *
 * Two policies are enforced here, both load-bearing:
 *
 *  1. SIGNAL-ONLY. A full snapshot is written only when a strategy actually
 *     produced a decision. At the default 15s scan interval, capturing every
 *     evaluation would be ~5,760 scans/day/symbol — tens of millions of rows
 *     per user per year, most of them recording that nothing happened. Scans
 *     where no setup formed are counted instead, in `scan_counters`.
 *
 *  2. APPEND-ONLY. Nothing in this module updates or deletes a capture row.
 *     The database enforces it too (see scripts/sql/capture-grants.sql) so the
 *     guarantee does not depend on this file staying disciplined.
 *
 * Every write is best-effort. Capture is an asset, not a safety mechanism —
 * it must never be the reason a scan fails or a trade goes unrecorded.
 */
import {
  db,
  capturedDecisionsTable,
  featureSnapshotsTable,
  scanCountersTable,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { configVersionOf, snapshotHashOf } from "./hashing";
import { logger } from "../logger";

export { configVersionOf, snapshotHashOf };
import { ENGINE_VERSION, MEMORY_VERSION_NONE } from "../version";
import type { Section } from "../engineRegistry";
import type { SignalRow } from "../strategy";
import type { DecisionKind } from "../decisionRecorder";

/** One symbol's inputs for this scan. */
export interface CaptureSnapshot {
  row: SignalRow;
  /** Close time of the newest candle behind `row` — market time, not now(). */
  dataTimestampMs: number;
}

/** A decision worth keeping, paired with its execution linkage if it ran. */
export interface CaptureDecision {
  outcome: DecisionKind;
  symbol: string;
  strategyId: string;
  side: string | null;
  confidence: number | null;
  stage: string | null;
  reason: string | null;
  payload: unknown;
  correlationId?: string;
  planFingerprint?: string;
}

export interface CaptureBatch {
  userId: number;
  section: Section;
  /** binance | oanda */
  provider: string;
  /** spot | futures | forex */
  venue: string;
  timeframe: string;
  /** Content hash of the effective strategy configs behind these decisions. */
  configVersion: string;
  /**
   * The memory state in force for this scan: "memory-0" when the decision core
   * read no memory at all, "memory-1:<hash>" when gated influence was active.
   *
   * Load-bearing for replay. A captured decision made under an active rule set
   * is not reproducible from features and config alone — the rules are a third
   * input — and a row that claimed "memory-0" while memory was withholding
   * trades would make the whole capture log quietly untrustworthy.
   */
  memoryVersion?: string;
  decisions: CaptureDecision[];
  /** symbol → the snapshot its decisions were made on. */
  snapshots: Map<string, CaptureSnapshot>;
}

/**
 * Persist one scan's decisions with their snapshots.
 *
 * Snapshots are deduplicated by content hash, so N strategies deciding on the
 * same symbol in the same scan share one row instead of storing N copies of
 * identical indicator state.
 */
export async function captureDecisions(batch: CaptureBatch): Promise<void> {
  if (batch.decisions.length === 0) return;

  // symbol → feature_snapshots.id, resolved once per symbol per scan.
  const snapshotIds = new Map<string, number>();

  for (const d of batch.decisions) {
    try {
      const snap = batch.snapshots.get(d.symbol);
      if (!snap) continue; // no inputs recorded ⇒ nothing reproducible to capture

      let snapshotId = snapshotIds.get(d.symbol);
      if (snapshotId === undefined) {
        snapshotId = await upsertSnapshot(batch, d.symbol, snap);
        if (snapshotId === undefined) continue;
        snapshotIds.set(d.symbol, snapshotId);
      }

      await db.insert(capturedDecisionsTable).values({
        userId: batch.userId,
        section: batch.section,
        ...(d.correlationId && { correlationId: d.correlationId }),
        ...(d.planFingerprint && { planFingerprint: d.planFingerprint }),
        featureSnapshotId: snapshotId,
        outcome: d.outcome,
        symbol: d.symbol,
        strategyId: d.strategyId,
        side: d.side,
        confidence: d.confidence != null ? String(d.confidence) : null,
        stage: d.stage,
        reason: d.reason,
        payload: d.payload ?? null,
        engineVersion: ENGINE_VERSION,
        configVersion: batch.configVersion,
        memoryVersion: batch.memoryVersion ?? MEMORY_VERSION_NONE,
        dataTimestamp: new Date(snap.dataTimestampMs),
      });
    } catch (err) {
      logger.warn({ err, symbol: d.symbol, strategyId: d.strategyId }, "CAPTURE_DECISION_FAILED");
    }
  }
}

/** Insert-or-reuse a snapshot by content hash. Returns its id. */
async function upsertSnapshot(
  batch: CaptureBatch,
  symbol: string,
  snap: CaptureSnapshot,
): Promise<number | undefined> {
  const hash = snapshotHashOf(
    batch.provider, batch.venue, symbol, batch.timeframe, snap.dataTimestampMs, snap.row,
  );
  try {
    // onConflictDoNothing keeps this INSERT-only: a snapshot already captured
    // is reused, never rewritten. Two scans producing identical features
    // legitimately share one row.
    const [inserted] = await db
      .insert(featureSnapshotsTable)
      .values({
        snapshotHash: hash,
        provider: batch.provider,
        venue: batch.venue,
        symbol,
        timeframe: batch.timeframe,
        dataTimestamp: new Date(snap.dataTimestampMs),
        features: snap.row as unknown as object,
      })
      .onConflictDoNothing()
      .returning({ id: featureSnapshotsTable.id });
    if (inserted) return inserted.id;

    const [existing] = await db
      .select({ id: featureSnapshotsTable.id })
      .from(featureSnapshotsTable)
      .where(eq(featureSnapshotsTable.snapshotHash, hash))
      .limit(1);
    return existing?.id;
  } catch (err) {
    logger.warn({ err, symbol }, "CAPTURE_SNAPSHOT_FAILED");
    return undefined;
  }
}

/**
 * Record that a symbol reached a stage without producing a decision — the
 * cheap counterpart to a full snapshot. Bucketed by UTC hour so the table
 * stays bounded at symbols × stages × hours no matter the scan interval.
 */
export async function recordScanCounters(
  userId: number,
  section: Section,
  now: Date,
  perSymbolStage: Map<string, string>,
): Promise<void> {
  if (perSymbolStage.size === 0) return;
  const hourBucket = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(),
  ));

  for (const [symbol, stage] of perSymbolStage) {
    try {
      await db
        .insert(scanCountersTable)
        .values({ userId, section, symbol, stage, hourBucket, count: 1 })
        .onConflictDoUpdate({
          target: [
            scanCountersTable.userId, scanCountersTable.section,
            scanCountersTable.symbol, scanCountersTable.stage, scanCountersTable.hourBucket,
          ],
          set: { count: sql`${scanCountersTable.count} + 1` },
        });
    } catch (err) {
      logger.warn({ err, symbol, stage }, "SCAN_COUNTER_FAILED");
    }
  }
}

/** Total scans counted for a user in a window — used by tests and diagnostics. */
export async function scanCounterTotal(userId: number, section: Section): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${scanCountersTable.count}), 0)::int` })
    .from(scanCountersTable)
    .where(and(eq(scanCountersTable.userId, userId), eq(scanCountersTable.section, section)));
  return row?.total ?? 0;
}
