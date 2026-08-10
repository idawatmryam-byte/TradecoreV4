/**
 * TradeCore Pro — RecommendExecutor (Co-Pilot)
 *
 * Runs the engine's exact scan, produces the exact same TradePlan AutoPilot
 * would have executed, and then — instead of placing an order — writes it down
 * and tells the user.
 *
 * The whole value depends on "exact". A Co-Pilot that recommended something
 * subtly different from what the bot would have done would be worse than
 * useless: the user would be reviewing a plan nobody was going to trade. That
 * is why the fork sits AFTER the plan is finished, and why the recommendation
 * stores the plan's fingerprint — a Co-Pilot recommendation and the AutoPilot
 * plan for the same scan hash identically, so the claim is checkable rather
 * than asserted.
 *
 * What Co-Pilot deliberately does NOT do here is decide anything. It does not
 * re-score, re-rank, filter, or hold plans back. Every plan that passed risk
 * reaches the inbox, and the human is the only filter.
 */
import { db, notificationsTable,
  recommendationEventsTable,
  recommendationsTable,
} from "@workspace/db";
import { randomUUID } from "crypto";
import { and, eq, lt } from "drizzle-orm";
import { logger } from "../logger";
import { planFingerprint } from "../plan/fingerprint";
import { buildDecisionTrace } from "../decisionTrace";
import type { ExecutionRequest, ExecutionResult, TradeExecutor,
} from "./executor";
import type { Section } from "../engineRegistry";
import {
  COPILOT_APPROVAL_POLICY_VERSION,
  COPILOT_BUNDLE_VERSION,
  COPILOT_REVALIDATION_POLICY_VERSION,
  fingerprintDecisionBundle,
  type Phase9DecisionBundle,
} from "../copilot/approvalBundle";

/**
 * How long a recommendation stays actionable, as a multiple of the plan's own
 * expected resolution time — the strategy already told us how long its thesis
 * is supposed to take, so that is the honest basis rather than a flat number
 * that would be far too long for a scalp and far too short for a swing.
 */
export const EXPIRY_MULTIPLE_OF_EXPECTED_HOLD = 0.5;
/** Floor and ceiling, so a degenerate plan cannot produce a silly window. */
export const MIN_EXPIRY_MS = 2 * 60_000;
export const MAX_EXPIRY_MS = 60 * 60_000;

export function expiryFor(
  plan: { expectedHoldSeconds: number }, now: Date,
): Date {
  const raw = (plan.expectedHoldSeconds ?? 0) * 1000 * EXPIRY_MULTIPLE_OF_EXPECTED_HOLD;
  const clamped = Math.min(MAX_EXPIRY_MS, Math.max(MIN_EXPIRY_MS, raw));
  return new Date(now.getTime() + clamped);
}

export interface RecommendExecutorHost {
  userId: () => number;
  section: () => Section;
}

export class RecommendExecutor implements TradeExecutor {
  readonly kind = "recommend" as const;

  constructor(private readonly host: RecommendExecutorHost) {}

  async execute(req: ExecutionRequest): Promise<ExecutionResult> {
    const { plan, row, now } = req;
    const userId = this.host.userId();
    const section = this.host.section();
    const correlationId = randomUUID();
    const fingerprint = planFingerprint(userId, plan);
    const expiresAt = expiryFor(plan, now);
    const decisionTrace = buildDecisionTrace(req.precedingStages, expiresAt);

    // Phase 9 never fabricates missing unified-brain context. A recommendation
    // without the exact same-scan bundle could not be supervised honestly and
    // is therefore refused before it reaches the inbox.
    if (!req.copilotSupervision) {
      return {
        entered: false,
        reason:
          "Co-Pilot: exact same-scan unified-brain context was unavailable; no approvable proposal was created",
      };
    }

    const supervision = req.copilotSupervision;
    const executionTarget =
      req.config.executionTarget === "demo" ? "demo" : "live";
    const approvalChallenge = randomUUID();
    const bundle: Phase9DecisionBundle = {
      schemaVersion: COPILOT_BUNDLE_VERSION,
      createdAt: now.toISOString(),
      planFingerprint: fingerprint,
      executionTarget,
      tradingMode: "copilot",
      authorizationScope: "single-controlled-execution-attempt",
      approvalPolicyVersion: COPILOT_APPROVAL_POLICY_VERSION,
      revalidationPolicyVersion: COPILOT_REVALIDATION_POLICY_VERSION,
      decisionAuthority: "brain-v0",
      unifiedBrain: {
        status: "shadow_context",
        reason:
          "The committed Phase 8 candidate remains Research/Shadow; its council output is evidence for supervision and has no execution authority.",
        run: supervision.councilRun,
      },
      marketState: supervision.marketState,
      specialistCouncil: supervision.specialistCouncil,
      portfolio: supervision.portfolio,
      risk: {
        verdict: "PASSED",
        checks: supervision.creationRiskChecks,
        candidateMaximumLoss:
          Math.abs(plan.entryPrice - plan.slPrice) * plan.qty,
        candidateNotional: plan.entryPrice * plan.qty,
        policyVersion: supervision.portfolio.policy.riskPolicyVersion,
      },
      managementAuthority: req.positionManagement?.assignment ?? null,
      versions: {
        plan: `strategy:${plan.strategyId}`,
        brain: supervision.councilRun.decision.versions.brain,
        council: supervision.councilRun.councilVersion,
        marketState: supervision.marketState.marketStateVersion,
        portfolio: supervision.portfolio.portfolioVersion,
        riskPolicy: supervision.portfolio.policy.riskPolicyVersion,
        managementPolicy:
          supervision.councilRun.decision.thesis?.managementPolicyVersion ??
          null,
      },
      limitations: [
        ...supervision.portfolio.dataIssues,
        ...(supervision.portfolio.context.correlationClusters.length === 0
          ? [
              "No authoritative correlation cluster was available at proposal creation.",
            ]
          : []),
        "Approval always revalidates current deterministic state; this snapshot cannot authorize execution by itself.",
      ],
    };
    const decisionBundleFingerprint = fingerprintDecisionBundle(bundle);

    try {
      const rec = await db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(recommendationsTable)
        .values({
          userId,
          section,
          correlationId,
          planFingerprint: fingerprint,
          status: "created",
          authoredBy: "engine",
          symbol: req.symbol,
          strategyId: plan.strategyId,
          strategyName: plan.strategyName,
          side: plan.side,
          confidence: plan.confidence.toFixed(2),
          entryPrice: plan.entryPrice.toFixed(8),
          slPrice: plan.slPrice.toFixed(8),
          tpPrice: plan.tpPrice.toFixed(8),
          qty: plan.qty.toFixed(8),
          leverage: plan.leverage,
          plan,
          signalRow: row as unknown as object,
          decisionTrace: decisionTrace as unknown as object,
            decisionBundle: bundle as unknown as object,
            decisionBundleFingerprint,
            executionTarget,
            approvalChallenge,
            expiresAt,
        })
        .returning();
        await tx.insert(recommendationEventsTable).values({
          recommendationId: inserted!.id,
          userId,
          section,
          eventType: "PROPOSED",
          actorType: "engine",
          actorUserId: null,
          fromStatus: null,
          toStatus: "created",
          planFingerprint: fingerprint,
          decisionBundleFingerprint,
          executionTarget,
          reasonCode: "COPILOT_PROPOSAL_CREATED",
          reason:
            "Immutable Co-Pilot proposal created for explicit human supervision",
          payload: {
            decisionId: supervision.councilRun.decision.decisionId,
            decisionFingerprint: supervision.councilRun.decisionFingerprint,
            portfolioFingerprint: supervision.portfolio.fingerprint,
          },
        });
        return inserted!;
      });

      // Reuse the in-app notification channel that already exists. Its `type`
      // column was added for exactly this producer.
      db.insert(notificationsTable)
        .values({
          userId,
          section,
          type: "copilot",
          severity: "info",
          message:
            `New Co-Pilot recommendation: ${plan.side.toUpperCase()} ${req.symbol} @ ${plan.entryPrice} ` +
            `(${plan.strategyName ?? plan.strategyId}, ${plan.confidence.toFixed(0)}% confidence). ` +
            `Expires ${expiresAt.toISOString().slice(11, 16)} UTC.`,
        })
        .catch((err) =>
          logger.warn(
            { err }, "Could not persist Co-Pilot notification (non-fatal)",
          ),
        );

      logger.info(
        {
          recommendationId: rec.id,
          symbol: req.symbol, side: plan.side,
          strategy: plan.strategyName, expiresAt: expiresAt.toISOString(),
        },
        "CO-PILOT: plan recorded for review — not executed",
      );

      return {
        entered: false,
        reason: `Co-Pilot: ${plan.side.toUpperCase()} ${req.symbol} recorded for your review (expires ${expiresAt.toISOString().slice(11, 16)} UTC)`,
        correlationId,
      };
    } catch (err) {
      logger.error(
        { err, symbol: req.symbol }, "Failed to record Co-Pilot recommendation",
      );
      return { entered: false, reason: `Co-Pilot: could not record the recommendation — ${String((err as Error)?.message ?? err)}`,
      };
    }
  }
}

/**
 * Mark past-due recommendations expired. Called from the scan loop, so the
 * inbox never shows an actionable plan that is no longer actionable.
 *
 * Expiry is enforced again at execute time regardless — this sweep is for the
 * UI's honesty, not for safety.
 */
export async function expireStaleRecommendations(userId: number, section: Section, now: Date,
): Promise<number> {
  try {
    return await db.transaction(async (tx) => {
      const rows = await tx
        .update(recommendationsTable)
      .set({ status: "expired", actedAt: now, resolutionReason: "expired before the user acted",
        })
      .where(and(
        eq(recommendationsTable.userId, userId),
        eq(recommendationsTable.section, section),
        eq(recommendationsTable.status, "created"),
        lt(recommendationsTable.expiresAt, now),
      ),
        )
      .returning({ id: recommendationsTable.id,
          planFingerprint: recommendationsTable.planFingerprint,
          decisionBundleFingerprint:
            recommendationsTable.decisionBundleFingerprint,
          executionTarget: recommendationsTable.executionTarget,
        });
      if (rows.length > 0) {
        await tx.insert(recommendationEventsTable).values(
          rows.map((row) => ({
            recommendationId: row.id,
            userId,
            section,
            eventType: "EXPIRED",
            actorType: "system",
            actorUserId: null,
            fromStatus: "created",
            toStatus: "expired",
            planFingerprint: row.planFingerprint,
            decisionBundleFingerprint: row.decisionBundleFingerprint,
            executionTarget: row.executionTarget,
            reasonCode: "PROPOSAL_EXPIRED",
            reason: "Proposal expired before the user acted",
          })),
        );
      }
      return rows.length;
  });
  } catch (err) {
    logger.warn({ err }, "Could not expire stale recommendations");
    return 0;
  }
}
