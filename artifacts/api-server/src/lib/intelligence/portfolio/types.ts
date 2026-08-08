import type { PortfolioContext } from "../contracts";

export const PORTFOLIO_INTELLIGENCE_VERSION = "shadow-portfolio-intelligence-v1" as const;
export const PORTFOLIO_POLICY_VERSION = "shadow-portfolio-policy-v1" as const;

export type PortfolioDataStatus = "healthy" | "degraded" | "blocked";
export type CorrelationKnowledge = "known" | "partial" | "unknown";
export type PortfolioDisposition =
  | "SHADOW_ALLOCATED"
  | "WAIT_FOR_TRIGGER"
  | "OBSERVE"
  | "REJECTED";

export interface PortfolioPositionInput {
  readonly symbol: string;
  readonly side: "long" | "short";
  readonly strategyId: string | null;
  readonly entryPrice: number;
  readonly stopPrice: number;
  readonly quantity: number;
}

export interface PortfolioOpportunityInput {
  readonly decisionId: string;
  readonly generatedAt: string;
  readonly dataTimestamp: string;
  readonly expiresAt: string;
  readonly symbol: string;
  readonly side: "long" | "short" | null;
  readonly action: "ENTER_NOW" | "WAIT_FOR_TRIGGER" | "OBSERVE" | "REJECT" | "REDUCE" | "EXIT";
  readonly strategyId: string | null;
  readonly strategyName: string | null;
  readonly entryPrice: number | null;
  readonly stopPrice: number | null;
  readonly targetPrice: number | null;
  readonly quantity: number | null;
  readonly netRewardRisk: number | null;
  readonly uncertainty: number;
  readonly decisionStrength: number;
  readonly regimeSuitability: number;
  readonly costPenalty: number;
  readonly liquidityProxy: "thin" | "normal" | "elevated";
  readonly sourceFingerprint: string;
}

export interface PairCorrelationInput {
  readonly a: string;
  readonly b: string;
  /** null means unknown, never zero. */
  readonly correlation: number | null;
}

export interface PortfolioPolicy {
  readonly policyVersion: typeof PORTFOLIO_POLICY_VERSION;
  readonly riskPolicyVersion: string;
  readonly maxOpenPositions: number;
  readonly maxPortfolioRiskFraction: number;
  readonly maxSymbolNotionalFraction: number;
  readonly maxNetExposureFraction: number;
  readonly maxCorrelatedNotionalFraction: number;
  readonly maxStrategyRiskFraction: number;
  readonly correlationThreshold: number;
  readonly unknownCorrelationPolicy: "allow" | "block";
  readonly drawdownDeRiskStartFraction: number;
  readonly drawdownHardFraction: number;
  readonly minimumAllocationFraction: number;
}

export interface BuildPortfolioIntelligenceInput {
  readonly asOf: string;
  readonly maximumCandidateAgeMs: number;
  readonly currency: string;
  readonly equity: number;
  readonly availableBalance: number;
  readonly drawdownFraction: number;
  readonly initialReservedRisk: number;
  readonly positions: readonly PortfolioPositionInput[];
  readonly opportunities: readonly PortfolioOpportunityInput[];
  readonly correlations: readonly PairCorrelationInput[];
  readonly policy: PortfolioPolicy;
  readonly dataStatus: PortfolioDataStatus;
  readonly dataIssues: readonly string[];
}

export interface OpportunityScoreComponents {
  readonly rewardRiskQuality: number;
  readonly decisionSupport: number;
  readonly regimeSuitability: number;
  readonly liquidityQuality: number;
  readonly diversificationBenefit: number;
  readonly costQuality: number;
  readonly uncertaintyQuality: number;
}

export interface PortfolioOpportunityAssessment {
  readonly rank: number;
  readonly decisionId: string;
  readonly sourceFingerprint: string;
  readonly symbol: string;
  readonly side: "long" | "short" | null;
  readonly action: PortfolioOpportunityInput["action"];
  readonly strategyId: string | null;
  readonly strategyName: string | null;
  readonly dataTimestamp: string;
  readonly expiresAt: string;
  readonly score: number;
  readonly scoreComponents: OpportunityScoreComponents;
  /** Null until probability calibration exists. Never fabricated from confidence. */
  readonly estimatedNetR: null;
  readonly netRewardRisk: number | null;
  readonly uncertainty: number;
  readonly requestedRisk: number;
  readonly requestedNotional: number;
  readonly allocatedRisk: number;
  readonly allocatedNotional: number;
  readonly allocatedQuantity: number;
  readonly allocationFraction: number;
  readonly disposition: PortfolioDisposition;
  readonly reasonCodes: readonly string[];
  readonly explanation: string;
  readonly correlationUnknownWith: readonly string[];
  readonly reinforcingClusterSymbols: readonly string[];
}

export interface PortfolioRiskUsage {
  readonly maximumStopRisk: number;
  readonly openStopRisk: number;
  readonly initiallyReservedRisk: number;
  readonly shadowReservedRisk: number;
  readonly remainingRisk: number;
  readonly drawdownScale: number;
  readonly openPositions: number;
  readonly shadowAllocatedPositions: number;
  readonly remainingPositionSlots: number;
}

export interface RetainedCash {
  readonly amount: number;
  readonly fractionOfAvailableBalance: number;
  readonly reasonCodes: readonly string[];
  readonly explanation: string;
}

export interface PortfolioIntelligenceProjection {
  readonly schemaVersion: "1.0.0";
  readonly portfolioVersion: typeof PORTFOLIO_INTELLIGENCE_VERSION;
  readonly mode: "shadow";
  readonly cannotExecute: true;
  readonly projectionId: string;
  readonly fingerprint: string;
  readonly generatedAt: string;
  readonly sourceScanTimestamp: string | null;
  readonly dataStatus: PortfolioDataStatus;
  readonly dataIssues: readonly string[];
  readonly policy: PortfolioPolicy;
  readonly context: PortfolioContext;
  readonly riskUsage: PortfolioRiskUsage;
  readonly opportunities: readonly PortfolioOpportunityAssessment[];
  readonly retainedCash: RetainedCash;
}

export const DEFAULT_PORTFOLIO_POLICY = {
  policyVersion: PORTFOLIO_POLICY_VERSION,
  riskPolicyVersion: "unresolved",
  maxOpenPositions: 5,
  maxPortfolioRiskFraction: 0.1,
  maxSymbolNotionalFraction: 1,
  maxNetExposureFraction: 2,
  maxCorrelatedNotionalFraction: 2,
  maxStrategyRiskFraction: 0.5,
  correlationThreshold: 0.7,
  unknownCorrelationPolicy: "allow",
  drawdownDeRiskStartFraction: 0.05,
  drawdownHardFraction: 0.2,
  minimumAllocationFraction: 0.25,
} as const satisfies PortfolioPolicy;
