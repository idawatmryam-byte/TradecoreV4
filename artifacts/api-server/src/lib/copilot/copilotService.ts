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
import { db, recommendationsTable } from "@workspace/db";
import type { Recommendation } from "@workspace/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { logger } from "../logger";
import { planFingerprint } from "../plan/fingerprint";
import { revalidate, type RevalidationCheck } from "../execution/revalidate";
import { expiryFor } from "../execution/recommendExecutor";
import { relabelTraceForModification, type PipelineStage } from "../decisionTrace";
import { getOrCreateEngine, type Section } from "../engineRegistry";
import { similarTradesFor } from "../knowledge/knowledgeService";
import { FEATURE_KEYS, type FeatureVector, type SimilarTradesResult } from "../knowledge/similarity";
import type { TradePlan } from "../strategies";
import type { SignalRow } from "../strategy";
import type { ExecutionResult } from "../execution/executor";

export interface ActionOutcome {
  ok: boolean;
  status: Recommendation["status"];
  reason: string;
  checks?: RevalidationCheck[];
  tradeId?: number;
  /** Set by modify(): the new, user-authored recommendation. */
  newRecommendationId?: number;
}

async function load(userId: number, section: Section, id: number): Promise<Recommendation | undefined> {
  const [rec] = await db
    .select()
    .from(recommendationsTable)
    .where(and(
      eq(recommendationsTable.id, id),
      eq(recommendationsTable.userId, userId),
      eq(recommendationsTable.section, section),
    ))
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
    ))
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

  const engine = getOrCreateEngine(userId, section);
  const state = await engine.gatherRevalidationState({
    symbol: rec.symbol,
    strategyId: rec.strategyId,
    entryPrice: Number(rec.entryPrice),
    slPrice: Number(rec.slPrice),
    qty: Number(rec.qty),
  });

  const candidateRiskUsdt = Math.abs(Number(rec.entryPrice) - Number(rec.slPrice)) * Number(rec.qty);
  const similarTrades = await similarTradesFor(userId, section, candidateFeatures(rec));

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
  userId: number, section: Section, id: number, now = new Date(),
): Promise<ActionOutcome> {
  const rec = await load(userId, section, id);
  if (!rec) return { ok: false, status: "created", reason: "Recommendation not found" };
  if (rec.status !== "created") {
    return { ok: false, status: rec.status, reason: `Already ${rec.status} — it cannot be executed` };
  }

  // Financial idempotency boundary. Loading `created` and updating only after
  // the broker call lets two concurrent requests both place an order. Claim
  // the row with one compare-and-set before gathering state or touching an
  // executor; exactly one caller can receive the row back.
  const [claimed] = await db
    .update(recommendationsTable)
    .set({ status: "executing", actedAt: now, resolutionReason: "approval claimed; re-validating current state" })
    .where(and(
      eq(recommendationsTable.id, rec.id),
      eq(recommendationsTable.userId, userId),
      eq(recommendationsTable.section, section),
      eq(recommendationsTable.status, "created"),
    ))
    .returning();
  if (!claimed) {
    const current = await load(userId, section, id);
    return {
      ok: false,
      status: current?.status ?? "blocked",
      reason: current ? `Already ${current.status} — it cannot be executed again` : "Recommendation not found",
    };
  }

  const engine = getOrCreateEngine(userId, section);
  const plan = rec.plan as TradePlan;
  const state = await engine.gatherRevalidationState({
    symbol: rec.symbol,
    strategyId: rec.strategyId,
    entryPrice: Number(rec.entryPrice),
    slPrice: Number(rec.slPrice),
    qty: Number(rec.qty),
  });

  const verdict = revalidate({
    plan: {
      symbol: rec.symbol, side: rec.side, strategyId: rec.strategyId,
      entryPrice: Number(rec.entryPrice), slPrice: Number(rec.slPrice), qty: Number(rec.qty),
    },
    expiresAt: rec.expiresAt,
    // `executing` is the database claim, not a change to the plan's semantic
    // eligibility. The compare-and-set above proved it was created exactly
    // once, so the pure validator should evaluate the claimed plan as such.
    status: "created",
    now,
    ...state,
  });

  if (!verdict.ok) {
    // Terminal. The situation that made this plan sensible has passed, so it
    // does not return to the inbox for another attempt — except when the plan
    // was already resolved, where the existing status is the truth.
    await db.update(recommendationsTable)
      .set({ status: "blocked", actedAt: now, resolutionReason: verdict.reason ?? verdict.code ?? "blocked" })
      .where(and(eq(recommendationsTable.id, rec.id), eq(recommendationsTable.status, "executing")));
    logger.info({ recommendationId: rec.id, code: verdict.code }, "CO-PILOT: approval refused at re-validation");
    return { ok: false, status: "blocked", reason: verdict.reason ?? "Re-validation failed", checks: verdict.checks };
  }

  const row = (rec.signalRow ?? { confidence: Number(rec.confidence), votes: [] }) as SignalRow;
  let result: ExecutionResult;
  try {
    result = await engine.executeApprovedPlan(plan, row, now);
  } catch (err) {
    const reason = "Execution failed after approval was claimed; verify broker and execution-intent state before taking any further action";
    await db.update(recommendationsTable)
      .set({ status: "blocked", actedAt: now, resolutionReason: reason })
      .where(and(eq(recommendationsTable.id, rec.id), eq(recommendationsTable.status, "executing")));
    logger.error({ err, recommendationId: rec.id }, "CO-PILOT: claimed approval threw during execution");
    return { ok: false, status: "blocked", reason, checks: verdict.checks };
  }

  if (!result.entered) {
    await db.update(recommendationsTable)
      .set({ status: "blocked", actedAt: now, resolutionReason: result.reason })
      .where(and(eq(recommendationsTable.id, rec.id), eq(recommendationsTable.status, "executing")));
    return { ok: false, status: "blocked", reason: result.reason, checks: verdict.checks };
  }

  await db.update(recommendationsTable)
    .set({
      status: "executed", actedAt: now,
      ...(result.tradeId != null && { tradeId: result.tradeId }),
      resolutionReason: result.reason,
    })
    .where(and(eq(recommendationsTable.id, rec.id), eq(recommendationsTable.status, "executing")));

  logger.info({ recommendationId: rec.id, tradeId: result.tradeId }, "CO-PILOT: user approved — position opened");
  return {
    ok: true, status: "executed", reason: result.reason,
    checks: verdict.checks, ...(result.tradeId != null && { tradeId: result.tradeId }),
  };
}

/** Decline a recommendation. Recorded, not deleted. */
export async function rejectRecommendation(
  userId: number, section: Section, id: number, note?: string, now = new Date(),
): Promise<ActionOutcome> {
  const rec = await load(userId, section, id);
  if (!rec) return { ok: false, status: "created", reason: "Recommendation not found" };
  if (rec.status !== "created") {
    return { ok: false, status: rec.status, reason: `Already ${rec.status} — nothing to reject` };
  }
  const [rejected] = await db.update(recommendationsTable)
    .set({ status: "rejected", actedAt: now, resolutionReason: note?.trim() || "declined by the user" })
    .where(and(
      eq(recommendationsTable.id, rec.id),
      eq(recommendationsTable.userId, userId),
      eq(recommendationsTable.section, section),
      eq(recommendationsTable.status, "created"),
    ))
    .returning({ id: recommendationsTable.id });
  if (!rejected) {
    const current = await load(userId, section, id);
    return { ok: false, status: current?.status ?? "blocked", reason: `Already ${current?.status ?? "resolved"} — nothing to reject` };
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
    return { ok: false, status: rec.status, reason: `Already ${rec.status} — it can no longer be modified` };
  }

  const original = rec.plan as TradePlan;
  const slPrice = changes.slPrice ?? Number(rec.slPrice);
  const tpPrice = changes.tpPrice ?? Number(rec.tpPrice);
  const qty = changes.qty ?? Number(rec.qty);

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

  const modifiedPlan: TradePlan = { ...original, slPrice, tpPrice, qty };
  const correlationId = randomUUID();
  const newExpiresAt = expiryFor(modifiedPlan, now);
  const derivedTrace = relabelTraceForModification(rec.decisionTrace as PipelineStage[] | null, newExpiresAt);

  const created = await db.transaction(async (tx) => {
    // Win the same lifecycle compare-and-set used by Execute and Reject.
    // The insert and original-state update commit together, so a failed child
    // insert can never strand the original as superseded without a replacement.
    const [claimedOriginal] = await tx.update(recommendationsTable)
      .set({ status: "superseded", actedAt: now, resolutionReason: "creating user-modified replacement" })
      .where(and(
        eq(recommendationsTable.id, rec.id),
        eq(recommendationsTable.userId, userId),
        eq(recommendationsTable.section, section),
        eq(recommendationsTable.status, "created"),
      ))
      .returning({ id: recommendationsTable.id });
    if (!claimedOriginal) return null;

    const [inserted] = await tx
      .insert(recommendationsTable)
      .values({
        userId,
        section,
        correlationId,
        planFingerprint: planFingerprint(userId, modifiedPlan),
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
        expiresAt: newExpiresAt,
      })
      .returning();
    await tx.update(recommendationsTable)
      .set({ resolutionReason: `replaced by your modified plan #${inserted!.id}` })
      .where(eq(recommendationsTable.id, rec.id));
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
