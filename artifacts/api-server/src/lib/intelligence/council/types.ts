import type { BrainDecision, EvidenceReference, MemoryEvidence } from "../contracts";
import type { MarketState } from "../market-state/types";
import type { SpecialistCouncilSnapshot } from "../specialists";
import type { TradePlan } from "../../strategies/base";

export const DECISION_COUNCIL_VERSION = "shadow-decision-council-v1" as const;
export const DETERMINISTIC_AGGREGATOR_VERSION = "deterministic-council-v1" as const;

export interface ExecutionCostContext {
  readonly feeRatePerLeg: number;
  readonly slippageRatePerLeg: number;
  readonly source: "engine-market-cost-model";
  readonly version: string;
}

/**
 * Phase 4 has only the balance available at the strategy boundary. Unknown
 * portfolio facts stay null until Phase 6 builds the authoritative context.
 */
export interface PreliminaryPortfolioContext {
  readonly status: "partial" | "unavailable";
  readonly currency: string;
  readonly availableBalance: number | null;
  readonly openPositionCount: number | null;
  readonly observedAt: string;
  readonly limitations: readonly string[];
}

export interface HistoricalEvidenceContext {
  readonly status: "unavailable" | "observational" | "approved";
  readonly ruleVersion: string | null;
  readonly items: readonly MemoryEvidence[];
  readonly limitations: readonly string[];
}

export interface BrainV0Candidate {
  readonly strategyId: string;
  readonly strategyName: string;
  readonly side: "long" | "short";
  readonly confidence: number;
  readonly netRewardRisk: number | null;
}

export interface BrainV0Comparison {
  readonly mode: "control";
  readonly candidateCount: number;
  readonly disposition: "CANDIDATE_PRODUCED" | "NO_CANDIDATE";
  readonly topCandidate: BrainV0Candidate | null;
}

export interface DeterministicAssessment {
  readonly version: typeof DETERMINISTIC_AGGREGATOR_VERSION;
  readonly longScore: number;
  readonly shortScore: number;
  readonly dominantShare: number;
  readonly averageEffectiveStrength: number;
  readonly regimeSuitability: number;
  readonly costPenalty: number;
  readonly decisionStrength: number;
  readonly thresholds: {
    readonly enterNow: number;
    readonly waitForTrigger: number;
  };
  readonly ruleTrace: readonly string[];
}

export interface ReasoningClaim {
  readonly claim: string;
  readonly evidenceIds: readonly string[];
}

export interface ReasoningUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly costUsd: number | null;
}

export interface CouncilReasoningReport {
  readonly status: "not_configured" | "validated" | "degraded" | "circuit_open" | "provider_error";
  readonly providerId: string | null;
  readonly modelVersion: string | null;
  readonly summary: string;
  readonly claims: readonly ReasoningClaim[];
  readonly challenges: readonly ReasoningClaim[];
  readonly uncertaintyNotes: readonly string[];
  readonly validationFailures: readonly string[];
  readonly attempts: number;
  readonly latencyMs: number;
  readonly usage: ReasoningUsage;
}

export interface ShadowReplayBundle {
  readonly marketState: MarketState;
  readonly specialistCouncil: SpecialistCouncilSnapshot;
  readonly executionCosts: ExecutionCostContext;
  readonly portfolio: PreliminaryPortfolioContext;
  readonly historicalEvidence: HistoricalEvidenceContext;
  readonly brainV0: BrainV0Comparison;
}

export interface ShadowCouncilRun {
  readonly schemaVersion: "1.0.0";
  readonly councilVersion: typeof DECISION_COUNCIL_VERSION;
  readonly runId: string;
  readonly inputFingerprint: string;
  readonly runFingerprint: string;
  readonly mode: "shadow";
  readonly cannotExecute: true;
  readonly generatedAt: string;
  readonly decision: BrainDecision;
  readonly decisionFingerprint: string;
  readonly deterministicAssessment: DeterministicAssessment;
  readonly reasoning: CouncilReasoningReport;
  readonly replay: ShadowReplayBundle;
}

export interface EvaluateDecisionCouncilInput {
  readonly marketState: MarketState;
  readonly specialistCouncil: SpecialistCouncilSnapshot;
  readonly brainV0Plans: readonly TradePlan[];
  readonly executionCosts: ExecutionCostContext;
  readonly portfolio: PreliminaryPortfolioContext;
  readonly historicalEvidence: HistoricalEvidenceContext;
  readonly generatedAt: string;
}

export interface DeterministicCouncilResult {
  readonly decision: BrainDecision;
  readonly decisionFingerprint: string;
  readonly inputFingerprint: string;
  readonly assessment: DeterministicAssessment;
  readonly brainV0: BrainV0Comparison;
  readonly knownEvidence: readonly EvidenceReference[];
}

