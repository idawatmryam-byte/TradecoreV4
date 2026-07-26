/**
 * TradeCore Pro — memory state loading, permission, and the influence log
 *
 * Where the pure rules in influence.ts meet the account they act on. Three
 * responsibilities, all of them safety-relevant:
 *
 *  PERMISSION. Enabling influence is not one flag, it is a conjunction. The
 *  user must have turned it on; there must be qualifying rules; and on LIVE
 *  the state's version must match a walk-forward validation that returned
 *  `improved`. Demo needs no approval — a simulated account is where a rule
 *  set is supposed to be tried, and requiring proof before it can ever run is
 *  a deadlock. That asymmetry is the paper-first rollout.
 *
 *  CACHING. The scan loop runs every 15 seconds by default. Rebuilding cells
 *  from the whole trade record on each pass would be both a performance
 *  problem and a subtle correctness one: the state a scan acts on should be
 *  stable, not silently different for the symbol evaluated last.
 *
 *  KILL SWITCH. `revoke()` clears both the flag and the cache for a user in
 *  one call, and the engine re-reads the cache each scan, so the next scan
 *  after a revoke runs with the inert state. No restart, no drain.
 */
import { db, botConfigTable, memoryInfluencesTable, memoryValidationsTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { logger } from "../logger";
import { loadObservations, currentExecutionTarget, type ExecutionTarget } from "../knowledge/knowledgeService";
import { buildKnowledge } from "../knowledge/cells";
import {
  buildInfluenceState, INERT_STATE, DEFAULT_MAX_DELTA,
  type InfluenceOutcome, type InfluenceState,
} from "./influence";
import { validateInfluence, type ValidationResult } from "./validation";
import type { Section } from "../engineRegistry";

/**
 * How long a built state is reused before it is rebuilt.
 *
 * Fifteen minutes: long enough that the scan loop never pays for it, short
 * enough that a user who just closed a run of trades sees the effect within a
 * coffee break. Memory is a slow-moving signal built from dozens of trades —
 * a state that changed every scan would be noise, not learning.
 */
export const STATE_TTL_MS = 15 * 60 * 1000;

interface CacheEntry {
  state: InfluenceState;
  builtAt: number;
  executionTarget: ExecutionTarget;
}

const cache = new Map<string, CacheEntry>();
const keyOf = (userId: number, section: Section) => `${userId}:${section}`;

/** Drop a cached state so the next scan rebuilds it. */
export function invalidate(userId: number, section: Section): void {
  cache.delete(keyOf(userId, section));
}

export interface MemoryPermission {
  /** The state the engine should act on. Inert unless every gate passed. */
  state: InfluenceState;
  /** Why influence is or is not active, in one sentence, for the UI and logs. */
  reason: string;
  executionTarget: ExecutionTarget;
  /** True when the user asked for it, regardless of whether it was granted. */
  requested: boolean;
  /** Set when live influence is blocked for want of a matching validation. */
  needsValidation: boolean;
}

/**
 * Build (or reuse) the influence state for one section, and decide whether the
 * engine is permitted to act on it.
 *
 * Never throws: a failure here must leave the engine trading exactly as it
 * would without memory, not stop it. The inert state is the safe default in
 * every error path.
 */
export async function loadMemoryPermission(
  userId: number,
  section: Section,
  now = Date.now(),
): Promise<MemoryPermission> {
  const inert = (reason: string, extra: Partial<MemoryPermission> = {}): MemoryPermission => ({
    state: INERT_STATE, reason, executionTarget: "demo",
    requested: false, needsValidation: false, ...extra,
  });

  try {
    const [cfg] = await db
      .select({
        enabled: botConfigTable.memoryInfluenceEnabled,
        maxDelta: botConfigTable.memoryInfluenceMaxDelta,
        approvedVersion: botConfigTable.memoryInfluenceApprovedVersion,
        executionTarget: botConfigTable.executionTarget,
      })
      .from(botConfigTable)
      .where(and(eq(botConfigTable.userId, userId), eq(botConfigTable.section, section)))
      .limit(1);

    const executionTarget: ExecutionTarget = cfg?.executionTarget === "demo" ? "demo" : "live";
    if (!cfg?.enabled) {
      // The common path, and the one that must cost nothing: no query, no
      // cell build, no state. Off means the feature is not there.
      return inert("Memory influence is off — the engine decides exactly as it would without it.", { executionTarget });
    }

    const maxDelta = Number(cfg.maxDelta) || DEFAULT_MAX_DELTA;
    const cached = cache.get(keyOf(userId, section));
    let state: InfluenceState;

    if (cached && cached.executionTarget === executionTarget && now - cached.builtAt < STATE_TTL_MS
        && cached.state.maxDelta === maxDelta) {
      state = cached.state;
    } else {
      const view = await loadObservations(userId, section, { executionTarget, asOf: new Date(now) });
      const report = buildKnowledge(view);
      state = buildInfluenceState(report, { maxDelta, enabled: true, now });
      cache.set(keyOf(userId, section), { state, builtAt: now, executionTarget });
    }

    if (state.rules.length === 0) {
      return inert(
        "Memory influence is on, but no cell in the record has both enough trades and evidence that survives multiple-comparison correction. Nothing is being adjusted.",
        { executionTarget, requested: true },
      );
    }

    // Paper-first: demo may act on a fresh state; live may not.
    if (executionTarget === "live" && cfg.approvedVersion !== state.version) {
      return inert(
        cfg.approvedVersion
          ? "The rules changed since the last approved validation, so live influence is paused until a new walk-forward run approves them."
          : "Live influence needs a walk-forward validation that beats the memory-off baseline out-of-sample. Run one, or trade this in demo first.",
        { executionTarget, requested: true, needsValidation: true },
      );
    }

    return {
      state,
      reason: `Memory influence active on ${state.rules.length} cell${state.rules.length === 1 ? "" : "s"} (${state.version}).`,
      executionTarget,
      requested: true,
      needsValidation: false,
    };
  } catch (err) {
    logger.warn({ err, userId, section }, "MEMORY_PERMISSION_FAILED — falling back to inert");
    return inert("Memory state could not be read; the engine is running without influence.");
  }
}

/**
 * The kill switch.
 *
 * Clears the flag and the cache together. The engine reloads permission every
 * scan, so the next scan is already inert — nothing to restart, nothing to
 * drain, and no in-flight decision keeps acting on a revoked rule set.
 */
export async function revokeInfluence(userId: number, section: Section, reason = "disabled by the user"): Promise<void> {
  await db
    .update(botConfigTable)
    .set({ memoryInfluenceEnabled: false, memoryInfluenceApprovedVersion: null })
    .where(and(eq(botConfigTable.userId, userId), eq(botConfigTable.section, section)));
  invalidate(userId, section);
  logger.warn({ userId, section, reason }, "MEMORY_INFLUENCE_REVOKED");
}

export interface LoggedInfluence {
  userId: number;
  section: Section;
  outcome: InfluenceOutcome;
  symbol: string;
  strategyId: string;
  executionTarget: ExecutionTarget;
  dataTimestampMs: number;
  correlationId?: string;
  planFingerprint?: string;
}

/**
 * Record an applied influence, admitted or not.
 *
 * Best-effort, like the capture log: an audit write must never be the reason a
 * scan fails. Both outcomes are logged — a log of only the withheld trades
 * would read as a list of saves and hide every time a rule fired harmlessly,
 * which is precisely the comparison needed to judge whether to keep it on.
 */
export async function logInfluence(entry: LoggedInfluence): Promise<void> {
  if (!entry.outcome.applied) return;
  try {
    await db.insert(memoryInfluencesTable).values({
      userId: entry.userId,
      section: entry.section,
      memoryVersion: entry.outcome.version,
      ...(entry.correlationId && { correlationId: entry.correlationId }),
      ...(entry.planFingerprint && { planFingerprint: entry.planFingerprint }),
      symbol: entry.symbol,
      strategyId: entry.strategyId,
      executionTarget: entry.executionTarget,
      admitted: entry.outcome.admitted,
      confidence: entry.outcome.confidence.toFixed(2),
      referenceConfidence: entry.outcome.reference.toFixed(2),
      delta: entry.outcome.delta.toFixed(2),
      requiredConfidence: entry.outcome.requiredConfidence.toFixed(2),
      rules: entry.outcome.rules,
      reason: entry.outcome.reason,
      dataTimestamp: new Date(entry.dataTimestampMs),
    });
  } catch (err) {
    logger.warn({ err, symbol: entry.symbol }, "MEMORY_INFLUENCE_LOG_FAILED");
  }
}

/**
 * Run a walk-forward validation and persist the verdict.
 *
 * On `improved` the approved version is written to config, which is what
 * unlocks live influence — and only for that exact state version, so a later
 * refit with different rules starts unapproved again.
 */
export async function runValidation(
  userId: number,
  section: Section,
  opts: { executionTarget?: ExecutionTarget; maxDelta?: number; now?: number } = {},
): Promise<{ id: number; result: ValidationResult }> {
  const now = opts.now ?? Date.now();
  const executionTarget = opts.executionTarget ?? (await currentExecutionTarget(userId, section));

  const [row] = await db
    .insert(memoryValidationsTable)
    .values({ userId, section, status: "running", executionTarget })
    .returning({ id: memoryValidationsTable.id });
  const id = row!.id;

  try {
    const [cfg] = await db
      .select({ maxDelta: botConfigTable.memoryInfluenceMaxDelta, threshold: botConfigTable.confidenceThreshold })
      .from(botConfigTable)
      .where(and(eq(botConfigTable.userId, userId), eq(botConfigTable.section, section)))
      .limit(1);

    const view = await loadObservations(userId, section, { executionTarget, asOf: new Date(now) });
    const result = validateInfluence(view, {
      maxDelta: opts.maxDelta ?? (Number(cfg?.maxDelta) || DEFAULT_MAX_DELTA),
      defaultThreshold: cfg?.threshold ?? 65,
      now,
    });

    await db.update(memoryValidationsTable).set({
      status: "completed",
      verdict: result.verdict,
      summary: result.summary,
      stateVersion: result.state.version,
      state: result.state as unknown as object,
      trainTrades: result.trainTrades,
      validationTrades: result.validationTrades,
      withheld: result.withheld,
      withheldPnlUsdt: result.withheldPnlUsdt.toFixed(8),
      expectancyDelta: result.expectancyDelta.toFixed(8),
      baseline: result.baseline,
      withMemory: result.withMemory,
      completedAt: new Date(now),
    }).where(eq(memoryValidationsTable.id, id));

    if (result.verdict === "improved") {
      await db.update(botConfigTable)
        .set({ memoryInfluenceApprovedVersion: result.state.version })
        .where(and(eq(botConfigTable.userId, userId), eq(botConfigTable.section, section)));
      logger.info({ userId, section, version: result.state.version }, "MEMORY_VALIDATION_APPROVED");
    } else {
      // A failed re-validation must not leave a stale approval standing.
      await db.update(botConfigTable)
        .set({ memoryInfluenceApprovedVersion: null })
        .where(and(eq(botConfigTable.userId, userId), eq(botConfigTable.section, section)));
    }

    invalidate(userId, section);
    return { id, result };
  } catch (err) {
    await db.update(memoryValidationsTable)
      .set({ status: "failed", error: String((err as Error)?.message ?? err), completedAt: new Date(now) })
      .where(eq(memoryValidationsTable.id, id));
    throw err;
  }
}

/** The most recent validation for a section, for the settings screen. */
export async function latestValidation(userId: number, section: Section) {
  const [row] = await db
    .select()
    .from(memoryValidationsTable)
    .where(and(eq(memoryValidationsTable.userId, userId), eq(memoryValidationsTable.section, section)))
    .orderBy(desc(memoryValidationsTable.createdAt))
    .limit(1);
  return row;
}

/** Recent applied influences, newest first — the audit trail as a feed. */
export async function recentInfluences(userId: number, section: Section, limit = 50) {
  return db
    .select()
    .from(memoryInfluencesTable)
    .where(and(eq(memoryInfluencesTable.userId, userId), eq(memoryInfluencesTable.section, section)))
    .orderBy(desc(memoryInfluencesTable.createdAt))
    .limit(Math.min(limit, 200));
}
