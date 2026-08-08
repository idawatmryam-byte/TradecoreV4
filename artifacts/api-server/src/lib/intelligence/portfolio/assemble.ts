import { sha256Fingerprint } from "../canonical";
import type { ShadowCouncilRun } from "../council";
import { buildPortfolioIntelligence } from "./planner";
import {
  DEFAULT_PORTFOLIO_POLICY,
  PORTFOLIO_POLICY_VERSION,
  type PairCorrelationInput,
  type PortfolioIntelligenceProjection,
  type PortfolioOpportunityInput,
  type PortfolioPositionInput,
} from "./types";

export interface PortfolioRuntimeConfig {
  readonly maxOpenPositions: number;
  readonly maxPortfolioRiskPercent: number;
  readonly maxSymbolConcentrationPercent: number;
  readonly maxNetExposurePercent: number;
  readonly maxCorrelatedExposurePercent: number;
  readonly correlationThreshold: number;
  readonly correlationUnknownPolicy: "allow" | "block";
}

export interface AssemblePortfolioProjectionInput {
  readonly now: Date;
  readonly engineRunning: boolean;
  readonly equity: number | null;
  readonly availableBalance: number | null;
  readonly dailyPnl: number;
  readonly positions: readonly PortfolioPositionInput[];
  readonly runs: readonly ShadowCouncilRun[];
  readonly expectedCouncilCount: number;
  readonly correlations: readonly PairCorrelationInput[];
  readonly config: PortfolioRuntimeConfig;
  readonly correlationIssue?: string | null;
  readonly positionIssue?: string | null;
  readonly runtimeLimitations?: readonly string[];
}

function latestScan(runs: readonly ShadowCouncilRun[]): {
  timestamp: string | null;
  runs: ShadowCouncilRun[];
  discarded: number;
} {
  const groups = new Map<string, ShadowCouncilRun[]>();
  for (const run of runs) groups.set(run.generatedAt, [...(groups.get(run.generatedAt) ?? []), run]);
  const timestamp = [...groups.keys()].sort().at(-1) ?? null;
  const selected = timestamp ? groups.get(timestamp)! : [];
  return { timestamp, runs: selected, discarded: runs.length - selected.length };
}

function opportunitiesOf(runs: readonly ShadowCouncilRun[]): PortfolioOpportunityInput[] {
  return runs.map((run) => {
    const plan = run.decision.proposedTrade;
    return {
      decisionId: run.decision.decisionId,
      generatedAt: run.generatedAt,
      dataTimestamp: run.decision.dataTimestamp,
      expiresAt: run.decision.expiresAt,
      symbol: run.decision.symbol,
      side: plan?.side ?? null,
      action: run.decision.action,
      strategyId: plan?.strategyId ?? run.replay.brainV0.topCandidate?.strategyId ?? null,
      strategyName: plan?.strategyName ?? run.replay.brainV0.topCandidate?.strategyName ?? null,
      entryPrice: plan?.entryPrice ?? null,
      stopPrice: plan?.stopPrice ?? null,
      targetPrice: plan?.targetPrice ?? null,
      quantity: plan?.quantity ?? null,
      netRewardRisk: plan?.netRewardRisk ?? null,
      uncertainty: run.decision.uncertainty.score,
      decisionStrength: run.deterministicAssessment.decisionStrength,
      regimeSuitability: run.deterministicAssessment.regimeSuitability,
      costPenalty: run.deterministicAssessment.costPenalty,
      liquidityProxy: run.replay.marketState.observations.liquidity.proxyStatus,
      sourceFingerprint: run.runFingerprint,
    };
  }).sort((a, b) => a.symbol.localeCompare(b.symbol) || a.decisionId.localeCompare(b.decisionId));
}

export function assemblePortfolioProjection(
  input: AssemblePortfolioProjectionInput,
): PortfolioIntelligenceProjection {
  const scan = latestScan(input.runs);
  const dataIssues: string[] = [];
  let dataStatus: "healthy" | "degraded" | "blocked" = "healthy";

  if (!input.engineRunning) {
    dataStatus = "degraded";
    dataIssues.push("The engine is stopped; this is the most recent Shadow opportunity set, not a live scan.");
  }
  if (input.equity == null || input.availableBalance == null) {
    dataStatus = "blocked";
    dataIssues.push("Account equity or available balance is unavailable; allocation cannot be sized.");
  }
  if (scan.timestamp == null) {
    dataStatus = dataStatus === "blocked" ? "blocked" : "degraded";
    dataIssues.push("No Shadow Decision Council scan is available yet.");
  }
  if (scan.runs.length < input.expectedCouncilCount) {
    dataStatus = "blocked";
    dataIssues.push(
      `Only ${scan.runs.length} of ${input.expectedCouncilCount} same-scan council decisions have settled; ranking waits for the complete set.`,
    );
  }
  if (scan.discarded > 0) {
    dataIssues.push(`${scan.discarded} older council projection(s) were excluded to preserve same-scan ranking.`);
  }
  if (input.runtimeLimitations?.length) {
    dataStatus = dataStatus === "blocked" ? "blocked" : "degraded";
    dataIssues.push(...input.runtimeLimitations);
  }
  if (input.positionIssue) {
    dataStatus = "blocked";
    dataIssues.push(input.positionIssue);
  }
  if (input.correlationIssue) {
    dataStatus = dataStatus === "blocked" ? "blocked" : "degraded";
    dataIssues.push(input.correlationIssue);
  }
  if (input.correlations.some((item) => item.correlation == null)) {
    dataStatus = dataStatus === "blocked" ? "blocked" : "degraded";
    dataIssues.push("Some pair correlations are unmeasurable; the configured unknown-correlation policy remains explicit.");
  }

  const riskPolicyInputs = {
    maxOpenPositions: input.config.maxOpenPositions,
    maxPortfolioRiskPercent: input.config.maxPortfolioRiskPercent,
    maxSymbolConcentrationPercent: input.config.maxSymbolConcentrationPercent,
    maxNetExposurePercent: input.config.maxNetExposurePercent,
    maxCorrelatedExposurePercent: input.config.maxCorrelatedExposurePercent,
    correlationThreshold: input.config.correlationThreshold,
    correlationUnknownPolicy: input.config.correlationUnknownPolicy,
    maxStrategyRiskFraction: DEFAULT_PORTFOLIO_POLICY.maxStrategyRiskFraction,
    drawdownDeRiskStartFraction: DEFAULT_PORTFOLIO_POLICY.drawdownDeRiskStartFraction,
    drawdownHardFraction: DEFAULT_PORTFOLIO_POLICY.drawdownHardFraction,
    minimumAllocationFraction: DEFAULT_PORTFOLIO_POLICY.minimumAllocationFraction,
  };
  const policy = {
    policyVersion: PORTFOLIO_POLICY_VERSION,
    riskPolicyVersion: `risk-policy-v1:${sha256Fingerprint(riskPolicyInputs).slice(0, 16)}`,
    maxOpenPositions: input.config.maxOpenPositions,
    maxPortfolioRiskFraction: input.config.maxPortfolioRiskPercent / 100,
    maxSymbolNotionalFraction: input.config.maxSymbolConcentrationPercent / 100,
    maxNetExposureFraction: input.config.maxNetExposurePercent / 100,
    maxCorrelatedNotionalFraction: input.config.maxCorrelatedExposurePercent / 100,
    maxStrategyRiskFraction: DEFAULT_PORTFOLIO_POLICY.maxStrategyRiskFraction,
    correlationThreshold: input.config.correlationThreshold,
    unknownCorrelationPolicy: input.config.correlationUnknownPolicy,
    drawdownDeRiskStartFraction: DEFAULT_PORTFOLIO_POLICY.drawdownDeRiskStartFraction,
    drawdownHardFraction: DEFAULT_PORTFOLIO_POLICY.drawdownHardFraction,
    minimumAllocationFraction: DEFAULT_PORTFOLIO_POLICY.minimumAllocationFraction,
  } as const;

  const equity = input.equity ?? 0;
  const drawdownFraction = equity > 0 && input.dailyPnl < 0
    ? Math.min(1, Math.abs(input.dailyPnl) / equity)
    : 0;

  return buildPortfolioIntelligence({
    asOf: input.now.toISOString(),
    maximumCandidateAgeMs: 15 * 60_000,
    currency: "USDT",
    equity,
    availableBalance: input.availableBalance ?? 0,
    drawdownFraction,
    initialReservedRisk: 0,
    positions: input.positions,
    opportunities: opportunitiesOf(scan.runs),
    correlations: input.correlations,
    policy,
    dataStatus,
    dataIssues,
  });
}
