/**
 * Memory permission and evidence lifecycle.
 *
 * Validation never authorizes behavior. The engine may use only the exact
 * immutable InfluenceState referenced by an ACTIVE lifecycle row and the
 * account configuration. Every transition is audited; every error is inert.
 */
import {
  db,
  botConfigTable,
  evidenceRuleEventsTable,
  evidenceRuleSetsTable,
  memoryInfluencesTable,
  memoryValidationsTable,
} from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { logger } from "../logger";
import {
  currentExecutionTarget,
  loadObservations,
  type ExecutionTarget,
} from "../knowledge/knowledgeService";
import {
  buildInfluenceState,
  DEFAULT_MAX_DELTA,
  INERT_STATE,
  type InfluenceOutcome,
  type InfluenceState,
} from "./influence";
import {
  MIN_VALIDATION_TRADES,
  validateInfluence,
  type ValidationResult,
} from "./validation";
import {
  PROMOTION_CONFIRMATION,
  ROLLBACK_CONFIRMATION,
  promotionDecision,
  rollbackDecision,
  type PromotionCandidate,
} from "../intelligence/evidence/lifecycle";
import { buildEvidenceSnapshot } from "../intelligence/evidence";
import {
  driftStatusForInfluenceState,
  persistEvidenceSnapshot,
} from "../intelligence/evidence/service";
import type { Section } from "../engineRegistry";

export const STATE_TTL_MS = 15 * 60 * 1000;

interface CacheEntry {
  state: InfluenceState;
  builtAt: number;
  executionTarget: ExecutionTarget;
  version: string;
}

const cache = new Map<string, CacheEntry>();
const keyOf = (userId: number, section: Section) => `${userId}:${section}`;

export function invalidate(userId: number, section: Section): void {
  cache.delete(keyOf(userId, section));
}

export interface MemoryPermission {
  state: InfluenceState;
  reason: string;
  executionTarget: ExecutionTarget;
  requested: boolean;
  needsValidation: boolean;
}

function parseInfluenceState(raw: unknown, expectedVersion: string): InfluenceState | null {
  if (!raw || typeof raw !== "object") return null;
  const state = raw as Partial<InfluenceState>;
  if (
    state.version !== expectedVersion
    || state.enabled !== true
    || !Array.isArray(state.rules)
    || state.rules.length === 0
    || typeof state.maxDelta !== "number"
    || !Number.isFinite(state.maxDelta)
  ) return null;
  return state as InfluenceState;
}

export async function loadMemoryPermission(
  userId: number,
  section: Section,
  now = Date.now(),
): Promise<MemoryPermission> {
  const inert = (reason: string, extra: Partial<MemoryPermission> = {}): MemoryPermission => ({
    state: INERT_STATE,
    reason,
    executionTarget: "demo",
    requested: false,
    needsValidation: false,
    ...extra,
  });

  try {
    const [config] = await db.select({
      enabled: botConfigTable.memoryInfluenceEnabled,
      approvedVersion: botConfigTable.memoryInfluenceApprovedVersion,
      executionTarget: botConfigTable.executionTarget,
    }).from(botConfigTable)
      .where(and(eq(botConfigTable.userId, userId), eq(botConfigTable.section, section)))
      .limit(1);

    const executionTarget: ExecutionTarget = config?.executionTarget === "demo" ? "demo" : "live";
    if (!config?.enabled) {
      return inert("Evidence influence is off; historical evidence cannot change a decision.", { executionTarget });
    }
    if (!config.approvedVersion) {
      return inert(
        "Influence was requested, but no exact evidence version is active. Validate a Shadow version and approve it explicitly.",
        { executionTarget, requested: true, needsValidation: true },
      );
    }

    const cached = cache.get(keyOf(userId, section));
    if (
      cached
      && cached.version === config.approvedVersion
      && cached.executionTarget === executionTarget
      && now - cached.builtAt < STATE_TTL_MS
    ) {
      return {
        state: cached.state,
        reason: `Validated evidence ${cached.version} is active with tightening-only authority.`,
        executionTarget,
        requested: true,
        needsValidation: false,
      };
    }

    const [ruleSet] = await db.select().from(evidenceRuleSetsTable)
      .where(and(
        eq(evidenceRuleSetsTable.userId, userId),
        eq(evidenceRuleSetsTable.section, section),
        eq(evidenceRuleSetsTable.ruleVersion, config.approvedVersion),
        eq(evidenceRuleSetsTable.status, "active"),
      ))
      .limit(1);

    if (!ruleSet) {
      return inert(
        "The configured evidence version has no ACTIVE lifecycle record, so influence failed closed.",
        { executionTarget, requested: true, needsValidation: true },
      );
    }
    if (ruleSet.executionTarget !== executionTarget) {
      return inert(
        `Evidence validated on ${ruleSet.executionTarget} cannot influence the ${executionTarget} account.`,
        { executionTarget, requested: true, needsValidation: true },
      );
    }
    const state = parseInfluenceState(ruleSet.state, config.approvedVersion);
    if (!state || ruleSet.permits !== "withhold") {
      return inert(
        "The active evidence payload failed its version or permission check, so influence failed closed.",
        { executionTarget, requested: true, needsValidation: true },
      );
    }

    cache.set(keyOf(userId, section), {
      state,
      builtAt: now,
      executionTarget,
      version: config.approvedVersion,
    });
    return {
      state,
      reason: `Validated evidence ${state.version} is active with tightening-only authority.`,
      executionTarget,
      requested: true,
      needsValidation: false,
    };
  } catch (error) {
    logger.warn({ error, userId, section }, "MEMORY_PERMISSION_FAILED — falling back to inert");
    return inert("Evidence state could not be verified; the engine is running without influence.");
  }
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
  } catch (error) {
    logger.warn({ error, symbol: entry.symbol }, "MEMORY_INFLUENCE_LOG_FAILED");
  }
}

export class EvidenceLifecycleError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = "EvidenceLifecycleError";
  }
}

function validationCandidate(row: typeof evidenceRuleSetsTable.$inferSelect): PromotionCandidate {
  const validation = row.validation as Partial<ValidationResult>;
  return {
    status: row.status as PromotionCandidate["status"],
    verdict: validation.verdict ?? "insufficient_data",
    permits: row.permits as PromotionCandidate["permits"],
    driftStatus: row.driftStatus as PromotionCandidate["driftStatus"],
    validationTrades: validation.validationTrades ?? 0,
    minimumValidationTrades: MIN_VALIDATION_TRADES,
  };
}

async function recordRefusal(
  userId: number,
  section: Section,
  ruleVersion: string,
  event: string,
  status: string,
  reason: string,
): Promise<never> {
  await db.insert(evidenceRuleEventsTable).values({
    userId, section, ruleVersion, event, fromStatus: status, toStatus: status,
    actor: "user", reason,
  });
  throw new EvidenceLifecycleError(409, reason);
}

async function activateEvidenceVersion(
  userId: number,
  section: Section,
  ruleVersion: string,
  confirmation: string,
  rollback: boolean,
) {
  const [row] = await db.select().from(evidenceRuleSetsTable)
    .where(and(
      eq(evidenceRuleSetsTable.userId, userId),
      eq(evidenceRuleSetsTable.section, section),
      eq(evidenceRuleSetsTable.ruleVersion, ruleVersion),
    )).limit(1);
  if (!row) throw new EvidenceLifecycleError(404, "Evidence version not found.");

  const target = await currentExecutionTarget(userId, section);
  if (row.executionTarget !== target) {
    return recordRefusal(userId, section, ruleVersion, rollback ? "rollback_refused" : "promotion_refused", row.status,
      `This version was validated on ${row.executionTarget}; the section currently uses ${target}.`);
  }
  const decision = rollback
    ? rollbackDecision(validationCandidate(row), confirmation)
    : promotionDecision(validationCandidate(row), confirmation);
  if (!decision.allowed) {
    return recordRefusal(userId, section, ruleVersion, rollback ? "rollback_refused" : "promotion_refused", row.status, decision.reason);
  }

  const now = new Date();
  await db.transaction(async (transaction) => {
    const activeRows = await transaction.select().from(evidenceRuleSetsTable)
      .where(and(
        eq(evidenceRuleSetsTable.userId, userId),
        eq(evidenceRuleSetsTable.section, section),
        eq(evidenceRuleSetsTable.status, "active"),
      ));
    for (const active of activeRows) {
      if (active.ruleVersion === ruleVersion) continue;
      await transaction.update(evidenceRuleSetsTable).set({
        status: "suspended", suspendedAt: now, updatedAt: now,
      }).where(eq(evidenceRuleSetsTable.id, active.id));
      await transaction.insert(evidenceRuleEventsTable).values({
        userId, section, ruleVersion: active.ruleVersion,
        event: "superseded", fromStatus: "active", toStatus: "suspended",
        actor: "system", reason: `Superseded by ${ruleVersion}.`,
      });
    }
    await transaction.update(evidenceRuleSetsTable).set({
      status: "active",
      approvedAt: row.approvedAt ?? now,
      activatedAt: now,
      suspendedAt: null,
      updatedAt: now,
    }).where(eq(evidenceRuleSetsTable.id, row.id));
    await transaction.update(botConfigTable).set({
      memoryInfluenceEnabled: true,
      memoryInfluenceApprovedVersion: ruleVersion,
    }).where(and(eq(botConfigTable.userId, userId), eq(botConfigTable.section, section)));
    await transaction.insert(evidenceRuleEventsTable).values({
      userId, section, ruleVersion,
      event: rollback ? "rolled_back" : "promoted",
      fromStatus: row.status,
      toStatus: "active",
      actor: "user",
      reason: decision.reason,
      metadata: { confirmation },
    });
  });
  invalidate(userId, section);
  logger.warn({ userId, section, ruleVersion, rollback }, "EVIDENCE_VERSION_ACTIVATED");
  return { ruleVersion, status: "active" as const, reason: decision.reason };
}

export function promoteEvidenceVersion(
  userId: number,
  section: Section,
  ruleVersion: string,
  confirmation: string,
) {
  return activateEvidenceVersion(userId, section, ruleVersion, confirmation, false);
}

export function rollbackEvidenceVersion(
  userId: number,
  section: Section,
  ruleVersion: string,
  confirmation: string,
) {
  return activateEvidenceVersion(userId, section, ruleVersion, confirmation, true);
}

export async function suspendEvidenceVersion(
  userId: number,
  section: Section,
  ruleVersion: string,
  reason = "Suspended by the user.",
) {
  const [row] = await db.select().from(evidenceRuleSetsTable)
    .where(and(
      eq(evidenceRuleSetsTable.userId, userId),
      eq(evidenceRuleSetsTable.section, section),
      eq(evidenceRuleSetsTable.ruleVersion, ruleVersion),
    )).limit(1);
  if (!row) throw new EvidenceLifecycleError(404, "Evidence version not found.");
  if (row.status !== "active") throw new EvidenceLifecycleError(409, `A ${row.status} version is already inert.`);
  const now = new Date();
  await db.transaction(async (transaction) => {
    await transaction.update(evidenceRuleSetsTable).set({
      status: "suspended", suspendedAt: now, updatedAt: now,
    }).where(eq(evidenceRuleSetsTable.id, row.id));
    await transaction.update(botConfigTable).set({
      memoryInfluenceEnabled: false,
      memoryInfluenceApprovedVersion: null,
    }).where(and(eq(botConfigTable.userId, userId), eq(botConfigTable.section, section)));
    await transaction.insert(evidenceRuleEventsTable).values({
      userId, section, ruleVersion, event: "suspended",
      fromStatus: "active", toStatus: "suspended", actor: "user", reason,
    });
  });
  invalidate(userId, section);
  logger.warn({ userId, section, ruleVersion, reason }, "EVIDENCE_VERSION_SUSPENDED");
  return { ruleVersion, status: "suspended" as const, reason };
}

/** Global kill switch kept for the existing UI and operational paths. */
export async function revokeInfluence(
  userId: number,
  section: Section,
  reason = "disabled by the user",
): Promise<void> {
  const [config] = await db.select({ version: botConfigTable.memoryInfluenceApprovedVersion })
    .from(botConfigTable)
    .where(and(eq(botConfigTable.userId, userId), eq(botConfigTable.section, section)))
    .limit(1);
  const now = new Date();
  await db.transaction(async (transaction) => {
    if (config?.version) {
      await transaction.update(evidenceRuleSetsTable).set({
        status: "suspended", suspendedAt: now, updatedAt: now,
      }).where(and(
        eq(evidenceRuleSetsTable.userId, userId),
        eq(evidenceRuleSetsTable.section, section),
        eq(evidenceRuleSetsTable.ruleVersion, config.version),
        eq(evidenceRuleSetsTable.status, "active"),
      ));
      await transaction.insert(evidenceRuleEventsTable).values({
        userId, section, ruleVersion: config.version, event: "kill_switch",
        fromStatus: "active", toStatus: "suspended", actor: "user", reason,
      });
    }
    await transaction.update(botConfigTable).set({
      memoryInfluenceEnabled: false,
      memoryInfluenceApprovedVersion: null,
    }).where(and(eq(botConfigTable.userId, userId), eq(botConfigTable.section, section)));
  });
  invalidate(userId, section);
  logger.warn({ userId, section, reason }, "MEMORY_INFLUENCE_REVOKED");
}

/**
 * Validate and persist a Shadow candidate. This function deliberately never
 * writes the approval fields in bot_config.
 */
export async function runValidation(
  userId: number,
  section: Section,
  opts: { executionTarget?: ExecutionTarget; maxDelta?: number; now?: number } = {},
): Promise<{ id: number; result: ValidationResult }> {
  const now = opts.now ?? Date.now();
  const executionTarget = opts.executionTarget ?? (await currentExecutionTarget(userId, section));
  const [created] = await db.insert(memoryValidationsTable)
    .values({ userId, section, status: "running", executionTarget })
    .returning({ id: memoryValidationsTable.id });
  const id = created!.id;

  try {
    const [config] = await db.select({
      maxDelta: botConfigTable.memoryInfluenceMaxDelta,
      threshold: botConfigTable.confidenceThreshold,
    }).from(botConfigTable)
      .where(and(eq(botConfigTable.userId, userId), eq(botConfigTable.section, section)))
      .limit(1);
    const view = await loadObservations(userId, section, { executionTarget, asOf: new Date(now) });
    const result = validateInfluence(view, {
      maxDelta: opts.maxDelta ?? (Number(config?.maxDelta) || DEFAULT_MAX_DELTA),
      defaultThreshold: config?.threshold ?? 65,
      now,
    });
    const snapshot = buildEvidenceSnapshot(view, { executionTarget, generatedAt: now });
    await persistEvidenceSnapshot(userId, section, snapshot);
    const driftStatus = driftStatusForInfluenceState(result.state, snapshot);

    await db.update(memoryValidationsTable).set({
      status: "completed",
      verdict: result.verdict,
      summary: result.summary,
      stateVersion: result.state.version,
      state: result.state as unknown as object,
      dataCutoff: new Date(result.dataCutoff),
      embargoMs: result.embargoMs,
      embargoedTrades: result.embargoedTrades,
      trainFrom: result.trainFrom ? new Date(result.trainFrom) : null,
      trainTo: result.trainTo ? new Date(result.trainTo) : null,
      validationFrom: result.validationFrom ? new Date(result.validationFrom) : null,
      validationTo: result.validationTo ? new Date(result.validationTo) : null,
      correction: result.correction,
      trainTrades: result.trainTrades,
      validationTrades: result.validationTrades,
      withheld: result.withheld,
      withheldPnlUsdt: result.withheldPnlUsdt.toFixed(8),
      expectancyDelta: result.expectancyDelta.toFixed(8),
      baseline: result.baseline,
      withMemory: result.withMemory,
      completedAt: new Date(now),
    }).where(eq(memoryValidationsTable.id, id));

    if (result.verdict === "improved" && result.state.rules.length > 0) {
      const [existing] = await db.select().from(evidenceRuleSetsTable)
        .where(and(
          eq(evidenceRuleSetsTable.userId, userId),
          eq(evidenceRuleSetsTable.section, section),
          eq(evidenceRuleSetsTable.ruleVersion, result.state.version),
        )).limit(1);
      const values = {
        validationId: id,
        state: result.state as unknown as object,
        validation: result as unknown as object,
        driftStatus,
        dataCutoff: new Date(result.dataCutoff),
        updatedAt: new Date(now),
      };
      if (existing) {
        await db.update(evidenceRuleSetsTable).set(values).where(eq(evidenceRuleSetsTable.id, existing.id));
      } else {
        await db.insert(evidenceRuleSetsTable).values({
          userId, section,
          ruleVersion: result.state.version,
          executionTarget,
          permits: "withhold",
          status: "shadow",
          ...values,
        });
      }
    }
    await db.insert(evidenceRuleEventsTable).values({
      userId, section, ruleVersion: result.state.version,
      event: "validation_completed", fromStatus: null,
      toStatus: result.verdict === "improved" ? "shadow" : null,
      actor: "system", reason: result.summary,
      metadata: { validationId: id, verdict: result.verdict, driftStatus },
    });
    invalidate(userId, section);
    logger.info({ userId, section, version: result.state.version, verdict: result.verdict }, "MEMORY_VALIDATION_COMPLETED_SHADOW_ONLY");
    return { id, result };
  } catch (error) {
    await db.update(memoryValidationsTable).set({
      status: "failed",
      error: String((error as Error)?.message ?? error),
      completedAt: new Date(now),
    }).where(eq(memoryValidationsTable.id, id));
    throw error;
  }
}

export async function latestValidation(userId: number, section: Section) {
  const [row] = await db.select().from(memoryValidationsTable)
    .where(and(eq(memoryValidationsTable.userId, userId), eq(memoryValidationsTable.section, section)))
    .orderBy(desc(memoryValidationsTable.createdAt)).limit(1);
  return row;
}

export async function recentInfluences(userId: number, section: Section, limit = 50) {
  return db.select().from(memoryInfluencesTable)
    .where(and(eq(memoryInfluencesTable.userId, userId), eq(memoryInfluencesTable.section, section)))
    .orderBy(desc(memoryInfluencesTable.createdAt)).limit(Math.min(limit, 200));
}

export { PROMOTION_CONFIRMATION, ROLLBACK_CONFIRMATION };
