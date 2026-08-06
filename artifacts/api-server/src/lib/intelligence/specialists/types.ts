import type { StrategyOpinion } from "../contracts";
import type { MarketState } from "../market-state/types";
import type { Strategy, StrategyConfig, TradePlan, TradeRejection } from "../../strategies/base";

export const SPECIALIST_COUNCIL_VERSION = "specialist-council-v1" as const;

export type SpecialistRole =
  | "trend"
  | "breakout"
  | "mean_reversion"
  | "volatility"
  | "market_structure"
  | "execution_quality"
  | "portfolio_conflict";

export type CouncilStance = "long" | "short" | "mixed" | "abstain";

export interface SpecialistEvaluationContext {
  readonly strategy: Strategy;
  readonly config: StrategyConfig;
  readonly plan: TradePlan | null;
  readonly rejection: TradeRejection | null;
  readonly generatedAt: string;
  readonly expiresAt: string;
}

export interface MarketSpecialist {
  readonly specialistId: string;
  readonly specialistVersion: string;
  readonly role: SpecialistRole;
  readonly correlationGroup: string;
  evaluate(marketState: MarketState, context: SpecialistEvaluationContext): StrategyOpinion;
}

export interface SpecialistOpinionView {
  readonly role: SpecialistRole;
  readonly correlationGroup: string;
  readonly correlationDiscount: number;
  readonly effectiveStrength: number;
  readonly operationalStatus: "active" | "abstained";
  readonly opinion: StrategyOpinion;
}

export interface SpecialistConsensus {
  readonly stance: CouncilStance;
  readonly longScore: number;
  readonly shortScore: number;
  readonly actionableOpinions: number;
  readonly abstentions: number;
  readonly disagreement: boolean;
  readonly explanation: string;
}

export interface SpecialistCouncilSnapshot {
  readonly schemaVersion: "1.0.0";
  readonly councilVersion: typeof SPECIALIST_COUNCIL_VERSION;
  readonly mode: "observational";
  readonly cannotExecute: true;
  readonly symbol: string;
  readonly marketStateFingerprint: string;
  readonly dataTimestamp: string;
  readonly generatedAt: string;
  readonly consensus: SpecialistConsensus;
  readonly opinions: readonly SpecialistOpinionView[];
}
