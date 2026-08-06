import { randomUUID } from "node:crypto";
import type { TradePlan } from "../strategies/base";
import {
  INTELLIGENCE_SCHEMA_VERSION,
  ProposedTradePlanSchema,
  parseBrainDecision,
  type BrainDecision,
  type EvidenceReference,
  type ProposedTradePlan,
} from "./contracts";
import { sha256Fingerprint } from "./canonical";

export interface TradePlanAdapterContext {
  marketStateFingerprint: string;
  dataTimestamp: string;
  expiresAt: string;
  brainVersion: string;
  strategyVersion: string;
  configVersion: string;
  marketStateVersion: string;
  decisionId?: string;
  thesisId?: string;
}

function evidence(
  plan: TradePlan,
  dataTimestamp: string,
  kind: "supporting" | "opposing",
): EvidenceReference[] {
  const lines = kind === "supporting"
    ? [...plan.report.marketView, ...plan.report.entryLogic, ...plan.report.checks.filter((check) => check.passed).map((check) => check.detail)]
    : plan.report.checks.filter((check) => !check.passed).map((check) => check.detail);
  return lines.map((summary, index) => ({
    evidenceId: "brain-v0-" + kind + "-" + index + "-" + sha256Fingerprint(summary).slice(0, 16),
    kind: "observation",
    source: "brain-v0-trade-plan",
    summary,
    reference: "TradePlan.report." + kind + "[" + index + "]",
    dataTimestamp,
    strength: Math.max(0, Math.min(1, plan.confidence / 100)),
  }));
}

export function proposedTradePlanFromV0(plan: TradePlan): ProposedTradePlan {
  return ProposedTradePlanSchema.parse({
    schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
    strategyId: plan.strategyId,
    strategyName: plan.strategyName,
    symbol: plan.symbol,
    side: plan.side,
    confidence: plan.confidence,
    entryPrice: plan.entryPrice,
    stopPrice: plan.slPrice,
    targetPrice: plan.tpPrice,
    quantity: plan.qty,
    leverage: Math.max(1, Math.round(plan.leverage)),
    expectedHoldSeconds: plan.expectedHoldSeconds,
    maxHoldSeconds: plan.maxHoldSeconds,
    regime: plan.regime,
    netRewardRisk: plan.netRewardRisk ?? null,
    report: plan.report,
  });
}

export function brainDecisionFromV0TradePlan(plan: TradePlan, context: TradePlanAdapterContext): BrainDecision {
  const proposedTrade = proposedTradePlanFromV0(plan);
  const stopCondition = plan.side === "long"
    ? "Price closes at or below " + plan.slPrice
    : "Price closes at or above " + plan.slPrice;
  return parseBrainDecision({
    schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
    decisionId: context.decisionId ?? randomUUID(),
    action: "ENTER_NOW",
    symbol: plan.symbol,
    marketStateFingerprint: context.marketStateFingerprint,
    supportingEvidence: evidence(plan, context.dataTimestamp, "supporting"),
    opposingEvidence: evidence(plan, context.dataTimestamp, "opposing"),
    uncertainty: {
      score: Math.max(0, Math.min(1, 1 - plan.confidence / 100)),
      reasons: ["Brain V0 confidence is a strategy score, not a calibrated probability."],
      calibrated: false,
    },
    dataTimestamp: context.dataTimestamp,
    expiresAt: context.expiresAt,
    invalidationConditions: [stopCondition],
    versions: {
      brain: context.brainVersion,
      strategy: context.strategyVersion,
      model: "deterministic-brain-v0",
      config: context.configVersion,
      marketState: context.marketStateVersion,
    },
    reasonCode: "BRAIN_V0_TRADE_PLAN",
    thesis: {
      schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
      thesisId: context.thesisId ?? randomUUID(),
      symbol: plan.symbol,
      side: plan.side,
      context: plan.report.marketView.join(" · ") || plan.report.summary,
      trigger: plan.report.entryLogic.join(" · ") || plan.report.summary,
      invalidationConditions: [stopCondition],
      targetRationale: plan.report.exitLogic.join(" · ") || "Brain V0 target",
      expectedPath: plan.report.entryLogic.length > 0 ? plan.report.entryLogic : [plan.report.summary],
      expectedDurationSeconds: plan.expectedHoldSeconds,
      managementPolicyVersion: "brain-v0-fixed-sltp",
    },
    proposedTrade,
  });
}

export function v0TradePlanFromProposed(plan: ProposedTradePlan): TradePlan {
  const parsed = ProposedTradePlanSchema.parse(plan);
  return {
    strategyId: parsed.strategyId,
    strategyName: parsed.strategyName,
    symbol: parsed.symbol,
    side: parsed.side,
    confidence: parsed.confidence,
    entryPrice: parsed.entryPrice,
    slPrice: parsed.stopPrice,
    tpPrice: parsed.targetPrice,
    qty: parsed.quantity,
    leverage: parsed.leverage,
    expectedHoldSeconds: parsed.expectedHoldSeconds,
    maxHoldSeconds: parsed.maxHoldSeconds,
    regime: parsed.regime as TradePlan["regime"],
    ...(parsed.netRewardRisk != null && { netRewardRisk: parsed.netRewardRisk }),
    report: parsed.report,
  };
}
