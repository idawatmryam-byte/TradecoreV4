/**
 * TradeCore Pro — Co-Pilot approval service
 *
 * What happens when a human acts on a recommendation. Three verbs, and the
 * interesting design lives in what each one refuses to do.
 *
 *   EXECUTE  re-asks the risk engine before placing anything. Approval is not
 *            "place this order", it is "is this still a good idea?". Without
 *            that, Co-Pilot would be strictly more dangerous than AutoPilot —
 *            the same trade taken later with none of the checks re-run.
 *
 *   REJECT   records the decision. A declined plan is data: it is how the
 *            platform eventually learns which of its own recommendations a
 *            trader consistently disagrees with.
 *
 *   MODIFY   does NOT edit the plan. It creates a NEW plan that references the
 *            original, authored by the user, re-validated from scratch; the
 *            original is superseded and keeps its numbers forever. Mutating in
 *            place would destroy the ability to say, later, whether a loss was
 *            the engine's decision or the user's override — and the immutable
 *            TradePlan is the claim the whole architecture rests on.
 */
import { randomUUID } from "crypto";
import { db,
  recommendationEventsTable,
  recommendationsTable,
} from "@workspace/db";
import type { Recommendation, RecommendationEvent } from "@workspace/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { logger } from "../logger";
import { planFingerprint } from "../plan/fingerprint";
import { revalidate, type RevalidationCheck } from "../execution/revalidate";
import { expiryFor } from "../execution/recommendExecutor";
import { relabelTraceForModification, type PipelineStage,
} from "../decisionTrace";
import { getOrCreateEngine, type Section } from "../engineRegistry";
import { similarTradesFor } from "../knowledge/knowledgeService";
import { FEATURE_KEYS, type FeatureVector, type SimilarTradesResult,
} from "../knowledge/similarity";
import type { TradePlan } from "../strategies";
import type { SignalRow } from "../strategy";
import type { ExecutionResult } from "../execution/executor";
import { sha256Fingerprint } from "../intelligence/canonical";
import {
  fingerprintDecisionBundle,
  isPhase9DecisionBundle,
  type Phase9DecisionBundle,
} from "./approvalBundle";

export interface ActionOutcome {
  ok: boolean;
  status: Recommendation["status"];
  reason: string;
  checks?: RevalidationCheck[];
  tradeId?: number;
  /** Set by modify(): the new, user-authored recommendation. */
  newRecommendationId?: number;
  code?: string;
  idempotentReplay?: boolean;
}

export interface ApprovalRequest {
  expectedPlanFingerprint: string;
  expectedDecisionBundleFingerprint: string;
  executionTarget: "demo" | "live";
  approvalChallenge: string;
  idempotencyKey: string;
  confirmation: string;
}

export interface RejectionRequest {
  expectedPlanFingerprint: string;
  approvalChallenge: string;
  note?: string;
}

export type ApprovalState =
  | "PROPOSED"
  | "APPROVABLE"
  | "APPROVED"
  | "REJECTED"
  | "EXPIRED"
  | "STALE"
  | "INVALIDATED"
  | "EXECUTION_BLOCKED";

async function load(userId: number, section: Section, id: number,
): Promise<Recommendation | undefined> {
  const [rec] = await db
    .select()
    .from(recommendationsTable)
    .where(and(
      eq(recommendationsTable.id, id),
      eq(recommendationsTable.userId, userId),
      eq(recommendationsTable.section, section),
    ),
    )
    .limit(1);
  return rec;
}

/** Live recommendations for the inbox, newest first. */
export async function listInbox(
  userId: number,
  section: Section,
  opts: { status?: Recommendation["status"][]; limit?: number } = {},
): Promise<Recommendation[]> {
  const statuses = opts.status?.length ? opts.status : (["created"] as Recommendation["status"][]);
  return db
    .select()
    .from(recommendationsTable)
    .where(and(
      eq(recommendationsTable.userId, userId),
      eq(recommendationsTable.section, section),
      inArray(recommendationsTable.status, statuses),
    ),
    )
    .orderBy(desc(recommendationsTable.createdAt))
    .limit(Math.min(opts.limit ?? 50, 200));
}

export interface PortfolioImpact {
  currentOpenPositions: number;
  maxOpenPositions: number;
  /** This plan's own worst-case dollar risk: |entry − stop| × qty. */
  candidateRiskUsdt: number;
  /** Aggregate risk of positions already open. */
  currentPortfolioRiskUsdt: number;
  /** currentPortfolioRiskUsdt + candidateRiskUsdt — what the cap would read if this trade executes. */
  afterPortfolioRiskUsdt: number;
  maxPortfolioRiskUsdt: number;
}

export interface RecommendationWorkspace {
  recommendation: Recommendation;
  /** Market Data → Indicators → Signal → Risk Checks → Order, as it stood at creation. */
  decisionTrace: unknown;
  portfolioImpact: PortfolioImpact;
  /**
   * Closed trades whose entry conditions resembled this one — cosine
   * similarity over z-score-normalised feature vectors, behind a pool gate and
   * a similarity floor (lib/knowledge/similarity.ts). Still reports
   * `available: false` with a reason whenever those gates are not met, which
   * on a young account is most of the time and is the correct answer.
   */
  similarTrades: SimilarTradesResult;
  decisionBundle: Phase9DecisionBundle | null;
  decisionBundleFingerprint: string | null;
  executionTarget: "demo" | "live" | null;
  approvalChallenge: string | null;
  approvalState: ApprovalState;
  approvalReadiness: {
    approvable: boolean;
    reason: string;
    checks: RevalidationCheck[];
  };
  auditEvents: RecommendationEvent[];
}

/** Persist a refusal that happens at the HTTP authorization boundary. */
export async function auditApprovalRefusal(
  userId: number,
  section: Section,
  id: number,
  code: string,
  reason: string,
): Promise<void> {
  const rec = await load(userId, section, id);
  if (!rec) return;
  await db.insert(recommendationEventsTable).values({
    recommendationId: rec.id,
    userId,
    section,
    eventType: "APPROVAL_REFUSED",
    actorType: "user",
    actorUserId: userId,
    fromStatus: rec.status,
    toStatus: rec.status,
    planFingerprint: rec.planFingerprint,
    decisionBundleFingerprint: rec.decisionBundleFingerprint,
    executionTarget: rec.executionTarget,
    reasonCode: code,
    reason,
  });
}

function approvalStateFor(
  rec: Recommendation,
  approvable = false,
  now = new Date(),
): ApprovalState {
  if (rec.status === "executed" || rec.status === "executing")
    return "APPROVED";
  if (rec.status === "rejected") return "REJECTED";
  if (
    rec.status === "expired" ||
    (rec.status === "created" && now >= rec.expiresAt)
  )
    return "EXPIRED";
  if (rec.status === "stale") return "STALE";
  if (rec.status === "invalidated" || rec.status === "superseded")
    return "INVALIDATED";
  if (rec.status === "blocked") return "EXECUTION_BLOCKED";
  return approvable ? "APPROVABLE" : "PROPOSED";
}

function idempotencyHash(approval: ApprovalRequest): string {
  return sha256Fingerprint({
    scope: "phase9-copilot-approval",
    key: approval.idempotencyKey,
    planFingerprint: approval.expectedPlanFingerprint,
    decisionBundleFingerprint: approval.expectedDecisionBundleFingerprint,
    executionTarget: approval.executionTarget,
    approvalChallenge: approval.approvalChallenge,
    confirmation: approval.confirmation,
  });
}

async function currentRevalidation(
  userId: number,
  section: Section,
  rec: Recommendation,
  now: Date,
) {
  const plan = rec.plan as TradePlan;
  const engine = getOrCreateEngine(userId, section);
  const state = await engine.gatherRevalidationState({
    symbol: rec.symbol,
    strategyId: rec.strategyId,
    side: rec.side === "short" ? "short" : "long",
    entryPrice: Number(rec.entryPrice),
    slPrice: Number(rec.slPrice),
    tpPrice: Number(rec.tpPrice),
    qty: Number(rec.qty),
  });
  const bundle = isPhase9DecisionBundle(rec.decisionBundle)
    ? rec.decisionBundle
    : null;
  const boundTarget =
    rec.executionTarget === "demo" || rec.executionTarget === "live"
      ? rec.executionTarget
      : "live";
  const verdict = revalidate({
    plan: {
      symbol: rec.symbol,
      side: rec.side,
      strategyId: rec.strategyId,
      entryPrice: Number(rec.entryPrice),
      slPrice: Number(rec.slPrice),
      qty: Number(rec.qty),
    },
    expiresAt: rec.expiresAt,
    status: rec.status === "executing" ? "created" : rec.status,
    now,
    ...state,
    safety: {
      planFingerprintMatches:
        planFingerprint(userId, plan) === rec.planFingerprint,
      decisionBundleFingerprintMatches:
        bundle !== null &&
        rec.decisionBundleFingerprint !== null &&
        fingerprintDecisionBundle(bundle) === rec.decisionBundleFingerprint &&
        bundle.planFingerprint === rec.planFingerprint,
      tradingMode: state.tradingMode,
      boundExecutionTarget: boundTarget,
      currentExecutionTarget: state.currentExecutionTarget,
      reconciliationHealthy: state.reconciliationHealthy,
      reconciliationDetail: state.reconciliationDetail,
      executionEligible: state.executionEligible,
      executionEligibilityDetail: state.executionEligibilityDetail,
      ...(state.marketDataTimestamp && {
        marketDataTimestamp: state.marketDataTimestamp,
      }),
      marketStateFresh: state.marketStateFresh,
      marketStateHealthy: state.marketStateHealthy,
      proposalRegime: plan.regime,
      ...(state.currentRegime && { currentRegime: state.currentRegime }),
      thesisValid: state.thesisValid,
      thesisDetail: state.thesisDetail,
      symbolExposureAfterUsdt: state.symbolExposureAfterUsdt,
      maxSymbolExposureUsdt: state.maxSymbolExposureUsdt,
      netExposureAfterUsdt: state.netExposureAfterUsdt,
      maxNetExposureUsdt: state.maxNetExposureUsdt,
      correlatedExposureAfterUsdt: state.correlatedExposureAfterUsdt,
      maxCorrelatedExposureUsdt: state.maxCorrelatedExposureUsdt,
      correlationKnownOrAllowed: state.correlationKnownOrAllowed,
      sizingValid: state.sizingValid,
      sizingDetail: state.sizingDetail,
      executionCostViable: state.executionCostViable,
      executionCostDetail: state.executionCostDetail,
    },
  });
  return { engine, plan, state, bundle, verdict };
}

/**
 * One recommendation's full picture for the workspace — the plan, its
 * reasoning at the moment it was made, and what taking it would do to the
 * portfolio right now. Read-only; changes nothing.
 */
export async function getRecommendationWorkspace(
  userId: number, section: Section, id: number,
): Promise<RecommendationWorkspace | null> {
  const rec = await load(userId, section, id);
  if (!rec) return null;

  const now = new Date();
  const { state, bundle, verdict } = await currentRevalidation(
    userId,
    section,
    rec,
    now,
  );

  const candidateRiskUsdt = Math.abs(Number(rec.entryPrice) - Number(rec.slPrice)) * Number(rec.qty);
  const similarTrades = await similarTradesFor(userId, section, candidateFeatures(rec),
  );
  const auditEvents = await db.select()
      .from(recommendationEventsTable)
      .where(and(eq(recommendationEventsTable.recommendationId, rec.id), eq(recommendationEventsTable.userId, userId),
        eq(recommendationEventsTable.section, section),
      ),
    )
      .orderBy(desc(recommendationEventsTable.occurredAt));

  return {
    recommendation: rec,
    decisionTrace: rec.decisionTrace ?? null,
    portfolioImpact: {
      currentOpenPositions: state.openPositions,
      maxOpenPositions: state.maxOpenPositions,
      candidateRiskUsdt,
      currentPortfolioRiskUsdt: state.openRiskUsdt,
      afterPortfolioRiskUsdt: state.openRiskUsdt + candidateRiskUsdt,
      maxPortfolioRiskUsdt: state.maxPortfolioRiskUsdt,
    },
    similarTrades,
    decisionBundle: bundle,
    decisionBundleFingerprint: rec.decisionBundleFingerprint,
    executionTarget:
      rec.executionTarget === "demo" || rec.executionTarget === "live"
        ? rec.executionTarget
        : null,
    approvalChallenge: rec.approvalChallenge,
    approvalState: approvalStateFor(rec, verdict.ok, now),
    approvalReadiness: {
      approvable: rec.status === "created" && verdict.ok,
      reason: verdict.ok
        ? "All current deterministic checks permit one controlled execution attempt"
        : (verdict.reason ?? "Approval is not currently allowed"),
      checks: verdict.checks,
    },
    auditEvents,
  };
}

/**
 * The candidate's comparison vector, read from the SignalRow captured when the
 * recommendation was made — not from live indicators. The question the panel
 * answers is "what happened after setups like THIS one", and this one is the
 * state the engine actually decided on.
 */
function candidateFeatures(rec: Recommendation): FeatureVector {
  const row = (rec.signalRow ?? {}) as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const key of FEATURE_KEYS) {
    const v = row[key];
    if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
  }
  if (out.confidence === undefined && rec.confidence != null) out.confidence = Number(rec.confidence);
  return out;
}

/**
 * Approve and execute — after re-checking everything that could have changed.
 */
export async function executeRecommendation(
  userId: number, section: Section, id: number,
  approval: ApprovalRequest,
  now = new Date(),
): Promise<ActionOutcome> {
  const rec = await load(userId, section, id);
  if (!rec) return { ok: false, status: "created", reason: "Recommendation not found" };
  const requestHash = idempotencyHash(approval);
  if (rec.status !== "created") {
    if (
      rec.approvalIdempotencyKeyHash === requestHash &&
      rec.approvalResult &&
      typeof rec.approvalResult === "object"
    ) {
      return {
        ...(rec.approvalResult as ActionOutcome),
        idempotentReplay: true,
      };
    }
    return {
      ok: false, status: rec.status, reason: `Already ${rec.status} — it cannot be executed`,
    };
  }

  const bindingFailure =
    approval.expectedPlanFingerprint !== rec.planFingerprint
      ? {
          code: "PLAN_BINDING_MISMATCH",
          reason: "The approval does not match the plan currently displayed",
        }
      : approval.expectedDecisionBundleFingerprint !==
          rec.decisionBundleFingerprint
        ? {
            code: "DECISION_BINDING_MISMATCH",
            reason:
              "The approval does not match the decision bundle currently displayed",
          }
        : approval.executionTarget !== rec.executionTarget
          ? {
              code: "TARGET_BINDING_MISMATCH",
              reason:
                "The approval target does not match the frozen proposal target",
            }
          : approval.approvalChallenge !== rec.approvalChallenge
            ? {
                code: "APPROVAL_CHALLENGE_MISMATCH",
                reason:
                  "The approval challenge is stale or invalid; reopen the proposal before acting",
              }
            : approval.confirmation !==
                `APPROVE ${rec.symbol} ${rec.side.toUpperCase()} FOR ${String(rec.executionTarget).toUpperCase()}`
              ? {
                  code: "CONFIRMATION_MISMATCH",
                  reason:
                    "The explicit approval phrase does not match this proposal's symbol, side, and target",
                }
              : null;
  if (bindingFailure) {
    await db.insert(recommendationEventsTable).values({
      recommendationId: rec.id,
      userId,
      section,
      eventType: "APPROVAL_REFUSED",
      actorType: "user",
      actorUserId: userId,
      fromStatus: rec.status,
      toStatus: rec.status,
      planFingerprint: rec.planFingerprint,
      decisionBundleFingerprint: rec.decisionBundleFingerprint,
      executionTarget: rec.executionTarget,
      reasonCode: bindingFailure.code,
      reason: bindingFailure.reason,
    });
    return {
      ok: false,
      status: rec.status,
      code: bindingFailure.code,
      reason: bindingFailure.reason,
    };
  }

  // Financial idempotency boundary. Loading `created` and updating only after
  // the broker call lets two concurrent requests both place an order. Claim
  // the row with one compare-and-set before gathering state or touching an
  // executor; exactly one caller can receive the row back.
  const claimed = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(recommendationsTable)
    .set({ status: "executing", actedAt: now,
        approvedByUserId: userId,
        approvalIdempotencyKeyHash: requestHash,
        resolutionReason: "approval claimed; re-validating current state",
      })
      .where(
        and(
          eq(recommendationsTable.id, rec.id),
      eq(recommendationsTable.userId, userId),
      eq(recommendationsTable.section, section),
      eq(recommendationsTable.status, "created"),
        ),
      )
      .returning();
  if (!row) return null;
    await tx.insert(recommendationEventsTable).values({
      recommendationId: rec.id,
      userId,
      section,
      eventType: "APPROVAL_REQUESTED",
      actorType: "user",
      actorUserId: userId,
      fromStatus: "created",
      toStatus: "executing",
      planFingerprint: rec.planFingerprint,
      decisionBundleFingerprint: rec.decisionBundleFingerprint,
      executionTarget: rec.executionTarget,
      reasonCode: "EXPLICIT_HUMAN_APPROVAL",
      reason:
        "User explicitly authorized one controlled execution attempt subject to fresh revalidation",
    });
    return row;
  });
  if (!claimed) {
    const current = await load(userId, section, id);
    if (
      current?.approvalIdempotencyKeyHash === requestHash &&
      current.approvalResult &&
      typeof current.approvalResult === "object"
    ) {
      return {
        ...(current.approvalResult as ActionOutcome),
        idempotentReplay: true,
      };
    }
    return {
      ok: false,
      status: current?.status ?? "blocked",
      reason: current ? `Already ${current.status} — it cannot be executed again` : "Recommendation not found",
    };
  }

  let current: Awaited<ReturnType<typeof currentRevalidation>>;
  try {
    current = await currentRevalidation(userId, section, claimed, now);
  } catch (err) {
    const reason = "Current financial state could not be established; approval failed closed and a new proposal is required";
    const outcome: ActionOutcome = { ok: false, status: "blocked", code: "REVALIDATION_UNAVAILABLE", reason };
    await db.transaction(async (tx) => {
      await tx.update(recommendationsTable)
        .set({ status: "blocked", actedAt: now, resolutionReason: reason, approvalResult: outcome as unknown as object })
        .where(and(eq(recommendationsTable.id, rec.id), eq(recommendationsTable.status, "executing")));
      await tx.insert(recommendationEventsTable).values({
        recommendationId: rec.id, userId, section, eventType: "APPROVAL_REFUSED",
        actorType: "system", actorUserId: userId, fromStatus: "executing", toStatus: "blocked",
        planFingerprint: rec.planFingerprint, decisionBundleFingerprint: rec.decisionBundleFingerprint,
        executionTarget: rec.executionTarget, reasonCode: "REVALIDATION_UNAVAILABLE", reason,
      });
    });
    logger.error({ err, recommendationId: rec.id }, "CO-PILOT: current state collection failed closed");
    return outcome;
  }
  const { engine, plan, verdict } = current;

  if (!verdict.ok) {
    // Terminal. The situation that made this plan sensible has passed, so it
    // does not return to the inbox for another attempt — except when the plan
    // was already resolved, where the existing status is the truth.
    const terminalStatus: Recommendation["status"] =
      verdict.code === "EXPIRED"
        ? "expired"
        : verdict.code === "MARKET_DATA_STALE" ||
            verdict.code === "PRICE_UNAVAILABLE" ||
            verdict.code === "PRICE_DRIFT"
          ? "stale"
          : verdict.code === "THESIS_INVALIDATED" ||
              verdict.code === "MARKET_STATE_INVALID" ||
              verdict.code === "PLAN_MUTATED" ||
              verdict.code === "DECISION_BUNDLE_MUTATED" ||
              verdict.code === "TARGET_CHANGED" ||
              verdict.code === "WRONG_MODE"
            ? "invalidated"
            : "blocked";
    const outcome: ActionOutcome = {
      ok: false,
      status: terminalStatus,
      code: verdict.code,
      reason: verdict.reason ?? "Re-validation failed",
      checks: verdict.checks,
    };
    await db.transaction(async (tx) => {
      await tx
        .update(recommendationsTable)
        .set({ status: terminalStatus,
          actedAt: now, resolutionReason: outcome.reason,
          lastValidation: verdict as unknown as object,
          approvalResult: outcome as unknown as object,
        })
        .where(
          and(
            eq(recommendationsTable.id, rec.id), eq(recommendationsTable.status, "executing"),
          ),
        );
      await tx.insert(recommendationEventsTable).values({
        recommendationId: rec.id,
        userId,
        section,
        eventType:
          terminalStatus === "expired"
            ? "EXPIRED"
            : terminalStatus === "stale"
              ? "STALE"
              : terminalStatus === "invalidated"
                ? "INVALIDATED"
                : "APPROVAL_REFUSED",
        actorType: "system",
        actorUserId: userId,
        fromStatus: "executing",
        toStatus: terminalStatus,
        planFingerprint: rec.planFingerprint,
        decisionBundleFingerprint: rec.decisionBundleFingerprint,
        executionTarget: rec.executionTarget,
        reasonCode: verdict.code ?? "REVALIDATION_FAILED",
        reason: outcome.reason,
        validationResult: verdict as unknown as object,
      });
    });
    logger.info(
      { recommendationId: rec.id, code: verdict.code }, "CO-PILOT: approval refused at re-validation",
    );
    return outcome;
  }

  await db.transaction(async (tx) => {
    await tx
      .update(recommendationsTable)
      .set({ lastValidation: verdict as unknown as object })
      .where(
        and(
          eq(recommendationsTable.id, rec.id),
          eq(recommendationsTable.status, "executing"),
        ),
      );
    await tx.insert(recommendationEventsTable).values({
      recommendationId: rec.id,
      userId,
      section,
      eventType: "APPROVAL_AUTHORIZED",
      actorType: "system",
      actorUserId: userId,
      fromStatus: "executing",
      toStatus: "executing",
      planFingerprint: rec.planFingerprint,
      decisionBundleFingerprint: rec.decisionBundleFingerprint,
      executionTarget: rec.executionTarget,
      reasonCode: "REVALIDATION_PASSED",
      reason:
        "Fresh deterministic revalidation authorized one execution attempt",
      validationResult: verdict as unknown as object,
    });
  });

  const row = (rec.signalRow ?? { confidence: Number(rec.confidence), votes: [],
  }) as SignalRow;
  let result: ExecutionResult;
  try {
    result = await engine.executeApprovedPlan(plan, row, now);
  } catch (err) {
    const reason = "Execution failed after approval was claimed; verify broker and execution-intent state before taking any further action";
    const outcome: ActionOutcome = {
      ok: false,
      status: "blocked",
      code: "EXECUTION_AMBIGUOUS",
      reason,
      checks: verdict.checks,
    };
    await db.transaction(async (tx) => {
      await tx
        .update(recommendationsTable)
        .set({ status: "blocked", actedAt: now, resolutionReason: reason,
          approvalResult: outcome as unknown as object,
        })
        .where(
          and(
            eq(recommendationsTable.id, rec.id), eq(recommendationsTable.status, "executing"),
          ),
        );
      await tx.insert(recommendationEventsTable).values({
        recommendationId: rec.id,
        userId,
        section,
        eventType: "EXECUTION_BLOCKED",
        actorType: "system",
        actorUserId: userId,
        fromStatus: "executing",
        toStatus: "blocked",
        planFingerprint: rec.planFingerprint,
        decisionBundleFingerprint: rec.decisionBundleFingerprint,
        executionTarget: rec.executionTarget,
        reasonCode: "EXECUTION_AMBIGUOUS",
        reason,
      });
    });
    logger.error(
      { err, recommendationId: rec.id }, "CO-PILOT: claimed approval threw during execution",
    );
    return outcome;
  }

  if (!result.entered) {
    const outcome: ActionOutcome = {
      ok: false, status: "blocked",
      code: "EXECUTION_REFUSED",
      reason: result.reason,
      checks: verdict.checks,
    };
    await db.transaction(async (tx) => {
    await tx
        .update(recommendationsTable)
        .set({ status: "blocked", actedAt: now, resolutionReason: result.reason,
          approvalResult: outcome as unknown as object,
        })
        .where(
          and(
            eq(recommendationsTable.id, rec.id), eq(recommendationsTable.status, "executing"),
          ),
        );
      await tx.insert(recommendationEventsTable).values({
        recommendationId: rec.id,
        userId,
        section,
        eventType: "EXECUTION_BLOCKED",
        actorType: "system",
        actorUserId: userId,
        fromStatus: "executing",
        toStatus: "blocked",
        planFingerprint: rec.planFingerprint,
        decisionBundleFingerprint: rec.decisionBundleFingerprint,
        executionTarget: rec.executionTarget,
        reasonCode: "EXECUTION_REFUSED",
        reason: result.reason,
      });
    });
    return outcome;
  }

  const outcome: ActionOutcome = { ok: true,
    status: "executed",
    code: "EXECUTION_SUCCEEDED",
    reason: result.reason, checks: verdict.checks,
    ...(result.tradeId != null && { tradeId: result.tradeId }),
  };
  await db.transaction(async (tx) => {
    await tx
      .update(recommendationsTable)
      .set({
      status: "executed", actedAt: now,
      ...(result.tradeId != null && { tradeId: result.tradeId }),
      resolutionReason: result.reason,
        approvalResult: outcome as unknown as object,
      })
      .where(
        and(
          eq(recommendationsTable.id, rec.id), eq(recommendationsTable.status, "executing"),
        ),
      );
    await tx.insert(recommendationEventsTable).values({
      recommendationId: rec.id,
      userId,
      section,
      eventType: "EXECUTION_SUCCEEDED",
      actorType: "system",
      actorUserId: userId,
      fromStatus: "executing",
      toStatus: "executed",
      planFingerprint: rec.planFingerprint,
      decisionBundleFingerprint: rec.decisionBundleFingerprint,
      executionTarget: rec.executionTarget,
      reasonCode: "EXECUTION_SUCCEEDED",
      reason: result.reason,
      payload: { ...(result.tradeId != null && { tradeId: result.tradeId }) },
    });
  });

  logger.info(
    { recommendationId: rec.id, tradeId: result.tradeId },
    "CO-PILOT: user approved — position opened",
  );
  return outcome;
}

/** Decline a recommendation. Recorded, not deleted. */
export async function rejectRecommendation(
  userId: number, section: Section, id: number,
  rejection: RejectionRequest,
  now = new Date(),
): Promise<ActionOutcome> {
  const rec = await load(userId, section, id);
  if (!rec) return { ok: false, status: "created", reason: "Recommendation not found" };
  if (rec.status !== "created") {
    return { ok: false, status: rec.status, reason: `Already ${rec.status} — nothing to reject`,
    };
  }
  if (
    rejection.expectedPlanFingerprint !== rec.planFingerprint ||
    rejection.approvalChallenge !== rec.approvalChallenge
  ) {
    const reason =
      "The rejection is bound to a stale or different proposal; reopen it before acting";
    await db.insert(recommendationEventsTable).values({
      recommendationId: rec.id,
      userId,
      section,
      eventType: "APPROVAL_REFUSED",
      actorType: "user",
      actorUserId: userId,
      fromStatus: rec.status,
      toStatus: rec.status,
      planFingerprint: rec.planFingerprint,
      decisionBundleFingerprint: rec.decisionBundleFingerprint,
      executionTarget: rec.executionTarget,
      reasonCode: "REJECTION_BINDING_MISMATCH",
      reason,
    });
    return {
      ok: false,
      status: rec.status,
      code: "REJECTION_BINDING_MISMATCH",
      reason,
    };
  }
  const reason = rejection.note?.trim() || "declined by the user";
  const rejected = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(recommendationsTable)
      .set({ status: "rejected", actedAt: now,
        rejectedByUserId: userId,
        resolutionReason: reason,
      })
      .where(
        and(
          eq(recommendationsTable.id, rec.id),
      eq(recommendationsTable.userId, userId),
      eq(recommendationsTable.section, section),
      eq(recommendationsTable.status, "created"),
        ),
      )
      .returning({ id: recommendationsTable.id });
  if (!row) return null;
    await tx.insert(recommendationEventsTable).values({
      recommendationId: rec.id,
      userId,
      section,
      eventType: "REJECTED",
      actorType: "user",
      actorUserId: userId,
      fromStatus: "created",
      toStatus: "rejected",
      planFingerprint: rec.planFingerprint,
      decisionBundleFingerprint: rec.decisionBundleFingerprint,
      executionTarget: rec.executionTarget,
      reasonCode: "EXPLICIT_HUMAN_REJECTION",
      reason,
    });
    return row;
  });
  if (!rejected) {
    const current = await load(userId, section, id);
    return { ok: false, status: current?.status ?? "blocked", reason: `Already ${current?.status ?? "resolved"} — nothing to reject`,
    };
  }
  return { ok: true, status: "rejected", reason: "Recommendation declined" };
}

export interface PlanModification {
  slPrice?: number;
  tpPrice?: number;
  qty?: number;
}

/**
 * Create a user-authored variant of an engine plan.
 *
 * The original is never touched. The new plan carries `derivedFromId`, is
 * marked `authoredBy: "user"`, gets its own fingerprint (its numbers differ,
 * so its content hash must too), and starts a fresh expiry window — it is a
 * new decision, made now, by a different author.
 */
export async function modifyRecommendation(
  userId: number, section: Section, id: number, changes: PlanModification, now = new Date(),
): Promise<ActionOutcome> {
  const rec = await load(userId, section, id);
  if (!rec) return { ok: false, status: "created", reason: "Recommendation not found" };
  if (rec.status !== "created") {
    return { ok: false, status: rec.status, reason: `Already ${rec.status} — it can no longer be modified`,
    };
  }

  const original = rec.plan as TradePlan;
  const slPrice = changes.slPrice ?? Number(rec.slPrice);
  const tpPrice = changes.tpPrice ?? Number(rec.tpPrice);
  const qty = changes.qty ?? Number(rec.qty);
  const originalBundle = isPhase9DecisionBundle(rec.decisionBundle)
    ? rec.decisionBundle
    : null;
  if (
    !originalBundle ||
    rec.decisionBundleFingerprint !== fingerprintDecisionBundle(originalBundle)
  ) {
    return {
      ok: false,
      status: rec.status,
      code: "DECISION_BUNDLE_INVALID",
      reason:
        "This proposal predates the Phase 9 immutable bundle or failed integrity validation; request a new proposal",
    };
  }

  // Geometry the engine would never have produced must not be creatable by
  // hand either. A stop on the wrong side of entry is not a preference.
  const isShort = rec.side === "short";
  const entry = Number(rec.entryPrice);
  const slOk = isShort ? slPrice > entry : slPrice < entry;
  const tpOk = isShort ? tpPrice < entry : tpPrice > entry;
  if (!slOk || !tpOk || !(qty > 0)) {
    return {
      ok: false, status: rec.status,
      reason: isShort
        ? "For a short, the stop must sit above the entry and the target below it, with a positive size"
        : "For a long, the stop must sit below the entry and the target above it, with a positive size",
    };
  }

  const stopTightensOrMatches = isShort
    ? slPrice <= Number(rec.slPrice)
    : slPrice >= Number(rec.slPrice);
  const riskReduced =
    qty <= Number(rec.qty) &&
    stopTightensOrMatches &&
    tpPrice === Number(rec.tpPrice);
  if (!riskReduced) {
    return {
      ok: false,
      status: rec.status,
      code: "NEW_PROPOSAL_REQUIRED",
      reason:
        "Only a smaller quantity or tighter protective stop may reuse this decision; target, size increases, and wider stops require a new engine proposal",
    };
  }

  const modifiedPlan: TradePlan = { ...original, slPrice, tpPrice, qty };
  const correlationId = randomUUID();
  const newExpiresAt = expiryFor(modifiedPlan, now);
  const derivedTrace = relabelTraceForModification(
    rec.decisionTrace as PipelineStage[] | null,
    newExpiresAt,
  );
  const modifiedPlanFingerprint = planFingerprint(userId, modifiedPlan);
  const modifiedBundle: Phase9DecisionBundle = {
    ...originalBundle,
    createdAt: now.toISOString(),
    planFingerprint: modifiedPlanFingerprint,
    risk: {
      ...originalBundle.risk,
      candidateMaximumLoss: Math.abs(entry - slPrice) * qty,
      candidateNotional: entry * qty,
    },
    limitations: [
      ...originalBundle.limitations,
      `Bounded user risk reduction derived from recommendation #${rec.id}; the original decision and thesis remain immutable evidence.`,
    ],
  };
  const modifiedBundleFingerprint = fingerprintDecisionBundle(modifiedBundle);
  const approvalChallenge = randomUUID();

  const created = await db.transaction(async (tx) => {
    // Win the same lifecycle compare-and-set used by Execute and Reject.
    // The insert and original-state update commit together, so a failed child
    // insert can never strand the original as superseded without a replacement.
    const [claimedOriginal] = await tx
      .update(recommendationsTable)
      .set({ status: "superseded", actedAt: now, resolutionReason: "creating user-modified replacement",
      })
      .where(
        and(
          eq(recommendationsTable.id, rec.id),
        eq(recommendationsTable.userId, userId),
        eq(recommendationsTable.section, section),
        eq(recommendationsTable.status, "created"),
        ),
      )
      .returning({ id: recommendationsTable.id });
    if (!claimedOriginal) return null;

    const [inserted] = await tx
      .insert(recommendationsTable)
      .values({
        userId,
        section,
        correlationId,
        planFingerprint: modifiedPlanFingerprint,
        status: "created",
        authoredBy: "user",
        derivedFromId: rec.id,
        symbol: rec.symbol,
        strategyId: rec.strategyId,
        strategyName: rec.strategyName,
        side: rec.side,
        confidence: rec.confidence,
        entryPrice: rec.entryPrice,
        slPrice: slPrice.toFixed(8),
        tpPrice: tpPrice.toFixed(8),
        qty: qty.toFixed(8),
        leverage: rec.leverage,
        plan: modifiedPlan,
        signalRow: rec.signalRow,
        decisionTrace: derivedTrace as unknown as object,
        decisionBundle: modifiedBundle as unknown as object,
        decisionBundleFingerprint: modifiedBundleFingerprint,
        executionTarget: rec.executionTarget,
        approvalChallenge,
        expiresAt: newExpiresAt,
      })
      .returning();
    await tx
      .update(recommendationsTable)
      .set({ resolutionReason: `replaced by your modified plan #${inserted!.id}`,
      })
      .where(eq(recommendationsTable.id, rec.id));
    await tx.insert(recommendationEventsTable).values([
      {
        recommendationId: rec.id,
        userId,
        section,
        eventType: "SUPERSEDED",
        actorType: "user",
        actorUserId: userId,
        fromStatus: "created",
        toStatus: "superseded",
        planFingerprint: rec.planFingerprint,
        decisionBundleFingerprint: rec.decisionBundleFingerprint,
        executionTarget: rec.executionTarget,
        reasonCode: "BOUNDED_RISK_REDUCTION",
        reason: `Superseded by bounded risk-reduction proposal #${inserted!.id}`,
      },
      {
        recommendationId: inserted!.id,
        userId,
        section,
        eventType: "PROPOSED",
        actorType: "user",
        actorUserId: userId,
        fromStatus: null,
        toStatus: "created",
        planFingerprint: modifiedPlanFingerprint,
        decisionBundleFingerprint: modifiedBundleFingerprint,
        executionTarget: rec.executionTarget,
        reasonCode: "BOUNDED_RISK_REDUCTION",
        reason: `User created a bounded risk-reduction variant of proposal #${rec.id}`,
      },
    ]);
    return inserted!;
  });

  if (!created) {
    const current = await load(userId, section, id);
    return {
      ok: false,
      status: current?.status ?? "blocked",
      reason: `Already ${current?.status ?? "resolved"} — it can no longer be modified`,
    };
  }

  logger.info(
    { original: rec.id, derived: created.id, slPrice, tpPrice, qty },
    "CO-PILOT: user authored a modified plan — original superseded, not edited",
  );

  return {
    ok: true, status: "superseded",
    reason: `Created your modified plan #${created.id}; the original is kept unchanged for the record`,
    newRecommendationId: created.id,
  };
}
