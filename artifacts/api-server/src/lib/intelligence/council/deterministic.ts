import {
  INTELLIGENCE_SCHEMA_VERSION,
  brainDecisionFingerprint,
  parseBrainDecision,
  type BrainDecision,
  type EvidenceReference,
} from "../contracts";
import { deepFreeze, sha256Fingerprint } from "../canonical";
import { proposedTradePlanFromV0 } from "../trade-plan-adapter";
import type { TradePlan } from "../../strategies/base";
import {
  DETERMINISTIC_AGGREGATOR_VERSION,
  type BrainV0Comparison,
  type DeterministicAssessment,
  type DeterministicCouncilResult,
  type EvaluateDecisionCouncilInput,
} from "./types";

const ENTER_NOW_THRESHOLD = 0.55;
const WAIT_FOR_TRIGGER_THRESHOLD = 0.30;
const MAX_DECISION_AGE_MS = 15 * 60_000;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function deterministicUuid(value: unknown): string {
  const chars = sha256Fingerprint(value).slice(0, 32).split("");
  chars[12] = "5";
  chars[16] = ((Number.parseInt(chars[16]!, 16) & 0x3) | 0x8).toString(16);
  const hex = chars.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function uniqueEvidence(items: readonly EvidenceReference[]): EvidenceReference[] {
  const byId = new Map<string, EvidenceReference>();
  for (const item of items) if (!byId.has(item.evidenceId)) byId.set(item.evidenceId, item);
  return [...byId.values()].slice(0, 100);
}

function compareBrainV0(plans: readonly TradePlan[]): BrainV0Comparison {
  const ordered = [...plans].sort((a, b) => b.confidence - a.confidence || a.strategyId.localeCompare(b.strategyId));
  const top = ordered[0];
  return deepFreeze({
    mode: "control",
    candidateCount: plans.length,
    disposition: plans.length > 0 ? "CANDIDATE_PRODUCED" : "NO_CANDIDATE",
    topCandidate: top ? {
      strategyId: top.strategyId,
      strategyName: top.strategyName,
      side: top.side,
      confidence: top.confidence,
      netRewardRisk: top.netRewardRisk ?? null,
    } : null,
  });
}

function selectedPlan(plans: readonly TradePlan[], side: "long" | "short"): TradePlan | null {
  return [...plans]
    .filter((plan) => plan.side === side)
    .sort((a, b) => b.confidence - a.confidence || (b.netRewardRisk ?? 0) - (a.netRewardRisk ?? 0) || a.strategyId.localeCompare(b.strategyId))[0] ?? null;
}

function planCostPenalty(plan: TradePlan | null, feeRate: number, slippageRate: number): number {
  if (!plan) return 0.25;
  const expectedMove = Math.abs(plan.tpPrice - plan.entryPrice) / plan.entryPrice;
  const roundTripCost = 2 * (feeRate + slippageRate);
  if (expectedMove <= 0) return 1;
  return clamp01(roundTripCost / expectedMove);
}

function expiry(dataTimestamp: string): string {
  return new Date(Date.parse(dataTimestamp) + MAX_DECISION_AGE_MS).toISOString();
}

function inputFingerprint(input: EvaluateDecisionCouncilInput): string {
  return sha256Fingerprint({
    councilVersion: DETERMINISTIC_AGGREGATOR_VERSION,
    marketStateFingerprint: input.marketState.fingerprint,
    opinionIds: input.specialistCouncil.opinions.map((item) => item.opinion.opinionId).sort(),
    plans: input.brainV0Plans,
    executionCosts: input.executionCosts,
    portfolio: input.portfolio,
    historicalEvidence: input.historicalEvidence,
  });
}

function buildThesis(plan: TradePlan, inputHash: string): BrainDecision["thesis"] {
  const stopCondition = plan.side === "long"
    ? `Price reaches or closes below the proposed protective stop at ${plan.slPrice}`
    : `Price reaches or closes above the proposed protective stop at ${plan.slPrice}`;
  return {
    schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
    thesisId: deterministicUuid({ inputHash, plan, type: "shadow-thesis" }),
    symbol: plan.symbol,
    side: plan.side,
    context: plan.report.marketView.join(" · ") || plan.report.summary,
    trigger: plan.report.entryLogic.join(" · ") || plan.report.summary,
    invalidationConditions: [stopCondition],
    targetRationale: plan.report.exitLogic.join(" · ") || "Target inherited from the Brain V0 candidate",
    expectedPath: plan.report.entryLogic.length > 0 ? plan.report.entryLogic : [plan.report.summary],
    expectedDurationSeconds: plan.expectedHoldSeconds,
    managementPolicyVersion: "shadow-fixed-sltp-v1",
  };
}

export function aggregateDecisionCouncil(input: EvaluateDecisionCouncilInput): DeterministicCouncilResult {
  if (input.specialistCouncil.marketStateFingerprint !== input.marketState.fingerprint) {
    throw new Error("Decision Council input mixes different MarketState fingerprints");
  }
  if (input.executionCosts.feeRatePerLeg < 0 || input.executionCosts.slippageRatePerLeg < 0) {
    throw new Error("Decision Council costs must be non-negative");
  }

  const fingerprint = inputFingerprint(input);
  const opinions = input.specialistCouncil.opinions;
  const active = opinions.filter((item) => item.operationalStatus === "active");
  const longScore = round(active.filter((item) => item.opinion.stance === "long").reduce((sum, item) => sum + item.effectiveStrength, 0));
  const shortScore = round(active.filter((item) => item.opinion.stance === "short").reduce((sum, item) => sum + item.effectiveStrength, 0));
  const dominantSide: "long" | "short" = longScore >= shortScore ? "long" : "short";
  const high = Math.max(longScore, shortScore);
  const low = Math.min(longScore, shortScore);
  const totalDirectional = high + low;
  const dominantShare = totalDirectional > 0 ? round(high / totalDirectional) : 0;
  const dominantViews = active.filter((item) => item.opinion.stance === dominantSide);
  const averageEffectiveStrength = dominantViews.length > 0
    ? round(high / dominantViews.length)
    : 0;
  const plan = selectedPlan(input.brainV0Plans, dominantSide);
  const costPenalty = round(planCostPenalty(plan, input.executionCosts.feeRatePerLeg, input.executionCosts.slippageRatePerLeg));
  const regimeSuitability = input.marketState.inferences.regimeConfidence;
  const decisionStrength = round(clamp01(averageEffectiveStrength * dominantShare * regimeSuitability * (1 - costPenalty)));
  const rules: string[] = [];

  let action: BrainDecision["action"] = "OBSERVE";
  let reasonCode = "INSUFFICIENT_SPECIALIST_SUPPORT";
  if (active.length === 0) {
    reasonCode = "NO_ELIGIBLE_SPECIALIST_SETUP";
    rules.push("Every eligible specialist abstained; the council explicitly chose no action.");
  } else if (input.specialistCouncil.consensus.disagreement) {
    reasonCode = "MATERIAL_SPECIALIST_DISAGREEMENT";
    rules.push("Material long/short disagreement blocks a directional candidate.");
  } else if (dominantSide === "short" && input.marketState.venue === "spot") {
    action = "REJECT";
    reasonCode = "MARKET_SIDE_UNAVAILABLE";
    rules.push("Spot execution cannot open the proposed short side.");
  } else if (!plan) {
    reasonCode = "NO_COMPATIBLE_TRADE_PLAN";
    rules.push("The leading opinion has no matching Brain V0 trade plan.");
  } else if (costPenalty >= 1) {
    action = "REJECT";
    reasonCode = "COSTS_OVERWHELM_EXPECTED_MOVE";
    rules.push("Estimated round-trip cost meets or exceeds the proposed target move.");
  } else if (decisionStrength >= ENTER_NOW_THRESHOLD) {
    action = "ENTER_NOW";
    reasonCode = "SHADOW_COUNCIL_ENTRY_CANDIDATE";
    rules.push("Support cleared the deterministic entry threshold after uncertainty and cost penalties.");
  } else if (decisionStrength >= WAIT_FOR_TRIGGER_THRESHOLD) {
    action = "WAIT_FOR_TRIGGER";
    reasonCode = "SHADOW_COUNCIL_WAIT_CANDIDATE";
    rules.push("Directional evidence exists, but support did not clear the entry threshold.");
  } else {
    rules.push("Penalized support remained below the wait threshold.");
  }

  const supportingEvidence = uniqueEvidence(dominantViews.flatMap((item) => item.opinion.supportingEvidence));
  const supportingIds = new Set(supportingEvidence.map((item) => item.evidenceId));
  const opposingEvidence = uniqueEvidence([
    ...dominantViews.flatMap((item) => item.opinion.opposingEvidence),
    ...active.filter((item) => item.opinion.stance !== dominantSide).flatMap((item) => item.opinion.supportingEvidence),
  ]).filter((item) => !supportingIds.has(item.evidenceId));
  const allKnownEvidence = uniqueEvidence(opinions.flatMap((item) => [
    ...item.opinion.supportingEvidence,
    ...item.opinion.opposingEvidence,
  ]));
  const planForDecision = plan && action !== "REJECT" ? plan : null;
  const thesis = planForDecision ? buildThesis(planForDecision, fingerprint) : null;
  const uncertaintyReasons = [
    "Decision strength is a deterministic support score, not a calibrated probability.",
    input.portfolio.status !== "partial" || input.portfolio.openPositionCount == null
      ? "Authoritative portfolio allocation context is not yet available."
      : "Only preliminary portfolio context is available.",
    input.historicalEvidence.status !== "approved"
      ? "No promoted historical evidence is permitted to influence this phase."
      : "Approved historical evidence was available.",
  ];

  const assessment: DeterministicAssessment = deepFreeze({
    version: DETERMINISTIC_AGGREGATOR_VERSION,
    longScore,
    shortScore,
    dominantShare,
    averageEffectiveStrength,
    regimeSuitability,
    costPenalty,
    decisionStrength,
    thresholds: { enterNow: ENTER_NOW_THRESHOLD, waitForTrigger: WAIT_FOR_TRIGGER_THRESHOLD },
    ruleTrace: rules,
  });

  const decision = parseBrainDecision({
    schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
    decisionId: deterministicUuid({ fingerprint, action, reasonCode }),
    action,
    symbol: input.marketState.symbol,
    marketStateFingerprint: input.marketState.fingerprint,
    supportingEvidence,
    opposingEvidence,
    uncertainty: {
      score: round(1 - decisionStrength),
      reasons: uncertaintyReasons,
      calibrated: false,
    },
    dataTimestamp: input.marketState.dataTimestamp,
    expiresAt: expiry(input.marketState.dataTimestamp),
    invalidationConditions: thesis?.invalidationConditions ?? ["A fresh closed-candle MarketState is required before reconsideration."],
    versions: {
      brain: "shadow-brain-v1",
      strategy: input.specialistCouncil.councilVersion,
      model: DETERMINISTIC_AGGREGATOR_VERSION,
      config: sha256Fingerprint({
        thresholds: { enterNow: ENTER_NOW_THRESHOLD, waitForTrigger: WAIT_FOR_TRIGGER_THRESHOLD },
        costs: input.executionCosts,
      }),
      marketState: input.marketState.marketStateVersion,
    },
    reasonCode,
    thesis,
    proposedTrade: planForDecision ? proposedTradePlanFromV0(planForDecision) : null,
  });

  return deepFreeze({
    decision,
    decisionFingerprint: brainDecisionFingerprint(decision),
    inputFingerprint: fingerprint,
    assessment,
    brainV0: compareBrainV0(input.brainV0Plans),
    knownEvidence: allKnownEvidence,
  });
}

