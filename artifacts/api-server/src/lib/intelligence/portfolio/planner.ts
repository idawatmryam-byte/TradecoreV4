import { PortfolioContextSchema, INTELLIGENCE_SCHEMA_VERSION, type PortfolioContext } from "../contracts";
import { deepFreeze, sha256Fingerprint } from "../canonical";
import {
  PORTFOLIO_INTELLIGENCE_VERSION,
  type BuildPortfolioIntelligenceInput,
  type OpportunityScoreComponents,
  type PairCorrelationInput,
  type PortfolioIntelligenceProjection,
  type PortfolioOpportunityAssessment,
  type PortfolioOpportunityInput,
  type PortfolioPolicy,
  type PortfolioPositionInput,
} from "./types";

const SCORE_WEIGHTS = {
  rewardRiskQuality: 0.22,
  decisionSupport: 0.20,
  regimeSuitability: 0.15,
  liquidityQuality: 0.10,
  diversificationBenefit: 0.14,
  costQuality: 0.10,
  uncertaintyQuality: 0.09,
} as const;

interface Exposure {
  symbol: string;
  side: "long" | "short";
  strategyId: string | null;
  notional: number;
  risk: number;
}

const round = (value: number, digits = 6): number => {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
};
const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
const pairKey = (a: string, b: string): string => [a, b].sort().join("|");

function deterministicUuid(value: unknown): string {
  const chars = sha256Fingerprint(value).slice(0, 32).split("");
  chars[12] = "5";
  chars[16] = ((Number.parseInt(chars[16]!, 16) & 0x3) | 0x8).toString(16);
  const hex = chars.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function assertFinite(label: string, value: number, minimum = -Infinity, maximum = Infinity): void {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be finite and between ${minimum} and ${maximum}`);
  }
}

function validatePolicy(policy: PortfolioPolicy): void {
  assertFinite("maxOpenPositions", policy.maxOpenPositions, 0);
  if (!Number.isInteger(policy.maxOpenPositions)) throw new Error("maxOpenPositions must be an integer");
  for (const [name, value] of Object.entries({
    maxPortfolioRiskFraction: policy.maxPortfolioRiskFraction,
    maxStrategyRiskFraction: policy.maxStrategyRiskFraction,
    correlationThreshold: policy.correlationThreshold,
    drawdownDeRiskStartFraction: policy.drawdownDeRiskStartFraction,
    drawdownHardFraction: policy.drawdownHardFraction,
    minimumAllocationFraction: policy.minimumAllocationFraction,
  })) assertFinite(name, value, 0, 1);
  for (const [name, value] of Object.entries({
    maxSymbolNotionalFraction: policy.maxSymbolNotionalFraction,
    maxNetExposureFraction: policy.maxNetExposureFraction,
    maxCorrelatedNotionalFraction: policy.maxCorrelatedNotionalFraction,
  })) assertFinite(name, value, 0);
  if (policy.drawdownHardFraction <= policy.drawdownDeRiskStartFraction) {
    throw new Error("drawdownHardFraction must exceed drawdownDeRiskStartFraction");
  }
}

function positionExposure(position: PortfolioPositionInput): Exposure {
  assertFinite(`${position.symbol}.entryPrice`, position.entryPrice, Number.MIN_VALUE);
  assertFinite(`${position.symbol}.stopPrice`, position.stopPrice, Number.MIN_VALUE);
  assertFinite(`${position.symbol}.quantity`, position.quantity, 0);
  const stopCorrect = position.side === "long"
    ? position.stopPrice < position.entryPrice
    : position.stopPrice > position.entryPrice;
  if (!stopCorrect) throw new Error(`${position.symbol} has a stop on the wrong side of entry`);
  return {
    symbol: position.symbol,
    side: position.side,
    strategyId: position.strategyId,
    notional: position.entryPrice * position.quantity,
    risk: Math.abs(position.entryPrice - position.stopPrice) * position.quantity,
  };
}

function correlationMap(correlations: readonly PairCorrelationInput[]): Map<string, number | null> {
  const map = new Map<string, number | null>();
  for (const item of correlations) {
    if (item.a === item.b) continue;
    if (item.correlation != null) assertFinite(`correlation ${item.a}/${item.b}`, item.correlation, -1, 1);
    const key = pairKey(item.a, item.b);
    const existing = map.get(key);
    if (map.has(key) && existing !== item.correlation) {
      throw new Error(`conflicting correlation values for ${key}`);
    }
    map.set(key, item.correlation);
  }
  return map;
}

function buildClusters(
  symbols: readonly string[],
  exposures: readonly Exposure[],
  correlations: Map<string, number | null>,
  threshold: number,
): {
  state: PortfolioContext["correlationState"];
  clusters: PortfolioContext["correlationClusters"];
} {
  const unique = [...new Set(symbols)].sort();
  const parent = new Map(unique.map((symbol) => [symbol, symbol]));
  const find = (symbol: string): string => {
    const p = parent.get(symbol)!;
    if (p === symbol) return symbol;
    const root = find(p);
    parent.set(symbol, root);
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  };

  let known = 0;
  let expected = 0;
  for (let i = 0; i < unique.length; i++) {
    for (let j = i + 1; j < unique.length; j++) {
      expected++;
      const value = correlations.get(pairKey(unique[i]!, unique[j]!));
      if (value == null) continue;
      known++;
      if (Math.abs(value) >= threshold) union(unique[i]!, unique[j]!);
    }
  }
  const grouped = new Map<string, string[]>();
  for (const symbol of unique) {
    const root = find(symbol);
    grouped.set(root, [...(grouped.get(root) ?? []), symbol]);
  }
  const clusters = [...grouped.values()].map((members) => {
    const ordered = members.sort();
    const exposure = exposures
      .filter((item) => ordered.includes(item.symbol))
      .reduce((sum, item) => sum + item.notional, 0);
    return {
      clusterId: `cluster-${sha256Fingerprint(ordered).slice(0, 12)}`,
      symbols: ordered,
      exposure: round(exposure),
    };
  }).sort((a, b) => a.clusterId.localeCompare(b.clusterId));

  const state: PortfolioContext["correlationState"] =
    expected === 0 || known === expected ? "known" : known === 0 ? "unknown" : "partial";
  return { state, clusters };
}

function drawdownScale(drawdown: number, policy: PortfolioPolicy): number {
  if (drawdown >= policy.drawdownHardFraction) return 0;
  if (drawdown <= policy.drawdownDeRiskStartFraction) return 1;
  const progress = (drawdown - policy.drawdownDeRiskStartFraction)
    / (policy.drawdownHardFraction - policy.drawdownDeRiskStartFraction);
  return round(Math.max(0.25, 1 - 0.75 * progress), 4);
}

function lookupCorrelation(a: string, b: string, correlations: Map<string, number | null>): number | null {
  if (a === b) return 1;
  return correlations.get(pairKey(a, b)) ?? null;
}

function correlationView(
  candidate: PortfolioOpportunityInput,
  exposures: readonly Exposure[],
  correlations: Map<string, number | null>,
  threshold: number,
): { unknown: string[]; reinforcing: Exposure[] } {
  if (!candidate.side) return { unknown: [], reinforcing: [] };
  const unknown: string[] = [];
  const reinforcing: Exposure[] = [];
  for (const exposure of exposures) {
    const value = lookupCorrelation(candidate.symbol, exposure.symbol, correlations);
    if (value == null) {
      unknown.push(exposure.symbol);
      continue;
    }
    const sameSide = exposure.side === candidate.side;
    if (value * (sameSide ? 1 : -1) >= threshold) reinforcing.push(exposure);
  }
  return {
    unknown: [...new Set(unknown)].sort(),
    reinforcing,
  };
}

function scoreComponents(
  candidate: PortfolioOpportunityInput,
  exposures: readonly Exposure[],
  correlations: Map<string, number | null>,
  policy: PortfolioPolicy,
  equity: number,
): OpportunityScoreComponents {
  const correlation = correlationView(candidate, exposures, correlations, policy.correlationThreshold);
  const clusterCap = equity * policy.maxCorrelatedNotionalFraction;
  const reinforcingNotional = correlation.reinforcing.reduce((sum, item) => sum + item.notional, 0);
  const diversificationBenefit = correlation.reinforcing.length > 0
    ? Math.max(0.1, 1 - reinforcingNotional / Math.max(clusterCap, Number.MIN_VALUE))
    : correlation.unknown.length > 0 ? 0.55 : 1;
  const liquidityQuality = candidate.liquidityProxy === "thin"
    ? 0.35 : candidate.liquidityProxy === "elevated" ? 0.9 : 0.75;
  return {
    rewardRiskQuality: round(clamp01((candidate.netRewardRisk ?? 0) / 3), 4),
    decisionSupport: round(clamp01(candidate.decisionStrength), 4),
    regimeSuitability: round(clamp01(candidate.regimeSuitability), 4),
    liquidityQuality,
    diversificationBenefit: round(clamp01(diversificationBenefit), 4),
    costQuality: round(clamp01(1 - candidate.costPenalty), 4),
    uncertaintyQuality: round(clamp01(1 - candidate.uncertainty), 4),
  };
}

function weightedScore(components: OpportunityScoreComponents): number {
  return round(Object.entries(SCORE_WEIGHTS).reduce(
    (sum, [key, weight]) => sum + components[key as keyof OpportunityScoreComponents] * weight,
    0,
  ), 4);
}

function requested(candidate: PortfolioOpportunityInput): { risk: number; notional: number } {
  if (
    candidate.entryPrice == null || candidate.stopPrice == null
    || candidate.quantity == null || candidate.quantity <= 0
  ) return { risk: 0, notional: 0 };
  return {
    risk: Math.abs(candidate.entryPrice - candidate.stopPrice) * candidate.quantity,
    notional: candidate.entryPrice * candidate.quantity,
  };
}

function netExposureScale(currentNet: number, signedCandidateNotional: number, cap: number): number {
  if (signedCandidateNotional > 0) return clamp01((cap - currentNet) / signedCandidateNotional);
  if (signedCandidateNotional < 0) return clamp01((currentNet + cap) / Math.abs(signedCandidateNotional));
  return 0;
}

function baseAssessment(
  candidate: PortfolioOpportunityInput,
  score: number,
  components: OpportunityScoreComponents,
  risk: number,
  notional: number,
): Omit<PortfolioOpportunityAssessment, "rank" | "allocatedRisk" | "allocatedNotional" | "allocatedQuantity" | "allocationFraction" | "disposition" | "reasonCodes" | "explanation" | "correlationUnknownWith" | "reinforcingClusterSymbols"> {
  return {
    decisionId: candidate.decisionId,
    symbol: candidate.symbol,
    side: candidate.side,
    action: candidate.action,
    strategyId: candidate.strategyId,
    strategyName: candidate.strategyName,
    dataTimestamp: candidate.dataTimestamp,
    expiresAt: candidate.expiresAt,
    score,
    scoreComponents: components,
    estimatedNetR: null,
    netRewardRisk: candidate.netRewardRisk,
    uncertainty: candidate.uncertainty,
    requestedRisk: round(risk),
    requestedNotional: round(notional),
  };
}

export function buildPortfolioIntelligence(
  input: BuildPortfolioIntelligenceInput,
): PortfolioIntelligenceProjection {
  validatePolicy(input.policy);
  const asOfMs = Date.parse(input.asOf);
  if (!Number.isFinite(asOfMs)) throw new Error("asOf must be an ISO timestamp");
  assertFinite("maximumCandidateAgeMs", input.maximumCandidateAgeMs, 1);
  assertFinite("equity", input.equity, 0);
  assertFinite("availableBalance", input.availableBalance, 0);
  assertFinite("drawdownFraction", input.drawdownFraction, 0, 1);
  assertFinite("initialReservedRisk", input.initialReservedRisk, 0);

  const openExposures = input.positions.map(positionExposure);
  const correlations = correlationMap(input.correlations);
  const sourceTimes = [...new Set(input.opportunities.map((item) => item.generatedAt))].sort();
  const mixedScans = sourceTimes.length > 1;
  const effectiveStatus = mixedScans ? "blocked" : input.dataStatus;
  const dataIssues = [...new Set([
    ...input.dataIssues,
    ...(mixedScans ? ["Opportunity set mixes scan timestamps; allocation is blocked until one complete scan settles."] : []),
  ])];
  const candidateSymbols = input.opportunities.map((candidate) => candidate.symbol);
  const clusters = buildClusters(
    [...openExposures.map((item) => item.symbol), ...candidateSymbols],
    openExposures,
    correlations,
    input.policy.correlationThreshold,
  );
  const remainingStopRisk = openExposures.reduce((sum, item) => sum + item.risk, 0);
  const grossExposure = openExposures.reduce((sum, item) => sum + item.notional, 0);
  const netExposure = openExposures.reduce(
    (sum, item) => sum + (item.side === "long" ? item.notional : -item.notional),
    0,
  );
  const contextBody = {
    schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
    asOf: input.asOf,
    currency: input.currency,
    equity: round(input.equity),
    availableBalance: round(input.availableBalance),
    openPositionCount: input.positions.length,
    remainingStopRisk: round(remainingStopRisk),
    grossExposure: round(grossExposure),
    netExposure: round(netExposure),
    drawdownFraction: round(input.drawdownFraction),
    reservedRisk: round(input.initialReservedRisk),
    correlationState: clusters.state,
    correlationClusters: clusters.clusters,
    riskPolicyVersion: input.policy.riskPolicyVersion,
  };
  const contextFingerprint = sha256Fingerprint(contextBody);
  const context = PortfolioContextSchema.parse({
    ...contextBody,
    contextId: deterministicUuid({ contextFingerprint, type: "portfolio-context" }),
    fingerprint: contextFingerprint,
  });

  const scoreExposure = [...openExposures];
  const ranked = input.opportunities.map((candidate) => {
    assertFinite(`${candidate.symbol}.uncertainty`, candidate.uncertainty, 0, 1);
    assertFinite(`${candidate.symbol}.decisionStrength`, candidate.decisionStrength, 0, 1);
    assertFinite(`${candidate.symbol}.regimeSuitability`, candidate.regimeSuitability, 0, 1);
    assertFinite(`${candidate.symbol}.costPenalty`, candidate.costPenalty, 0, 1);
    const components = scoreComponents(candidate, scoreExposure, correlations, input.policy, input.equity);
    const req = requested(candidate);
    return { candidate, components, score: weightedScore(components), ...req };
  }).sort((a, b) =>
    b.score - a.score
    || b.candidate.decisionStrength - a.candidate.decisionStrength
    || a.candidate.symbol.localeCompare(b.candidate.symbol)
    || a.candidate.decisionId.localeCompare(b.candidate.decisionId)
  );

  const scale = drawdownScale(input.drawdownFraction, input.policy);
  const maximumStopRisk = input.equity * input.policy.maxPortfolioRiskFraction * scale;
  let shadowReservedRisk = 0;
  let shadowAllocatedPositions = 0;
  let runningNet = netExposure;
  const reservedExposures: Exposure[] = [];
  const strategyRisk = new Map<string, number>();
  for (const exposure of openExposures) {
    if (!exposure.strategyId) continue;
    strategyRisk.set(exposure.strategyId, (strategyRisk.get(exposure.strategyId) ?? 0) + exposure.risk);
  }

  const assessments: PortfolioOpportunityAssessment[] = [];
  for (let index = 0; index < ranked.length; index++) {
    const item = ranked[index]!;
    const candidate = item.candidate;
    const base = baseAssessment(candidate, item.score, item.components, item.risk, item.notional);
    const exposures = [...openExposures, ...reservedExposures];
    const corr = correlationView(candidate, exposures, correlations, input.policy.correlationThreshold);
    const reasonCodes: string[] = [];
    let explanation = "";
    let disposition: PortfolioOpportunityAssessment["disposition"] = "REJECTED";
    let allocationFraction = 0;

    const dataMs = Date.parse(candidate.dataTimestamp);
    const expiryMs = Date.parse(candidate.expiresAt);
    const stale = !Number.isFinite(dataMs) || !Number.isFinite(expiryMs)
      || dataMs > asOfMs
      || expiryMs <= asOfMs
      || asOfMs - dataMs > input.maximumCandidateAgeMs;

    if (effectiveStatus === "blocked") {
      reasonCodes.push("PORTFOLIO_DATA_BLOCKED");
      explanation = "Portfolio inputs are blocked, so no allocation can be proposed.";
    } else if (stale) {
      reasonCodes.push(dataMs > asOfMs ? "FUTURE_DATA_TIMESTAMP" : "STALE_DECISION");
      explanation = "The decision is stale, expired, or newer than the portfolio context.";
    } else if (candidate.action === "WAIT_FOR_TRIGGER") {
      disposition = "WAIT_FOR_TRIGGER";
      reasonCodes.push("WAITING_FOR_TRIGGER");
      explanation = "The opportunity remains ranked, but its trigger has not been satisfied.";
    } else if (candidate.action !== "ENTER_NOW") {
      disposition = "OBSERVE";
      reasonCodes.push("ACTION_NOT_ENTRY");
      explanation = "The council did not propose an immediate entry.";
    } else if (!candidate.side || item.risk <= 0 || item.notional <= 0 || candidate.quantity == null) {
      reasonCodes.push("NO_EXECUTABLE_PLAN");
      explanation = "The candidate has no complete, valid entry/stop/quantity plan.";
    } else if (scale === 0) {
      reasonCodes.push("DRAWDOWN_HARD_STOP");
      explanation = "The drawdown policy retains all risk budget.";
    } else if (input.positions.length + shadowAllocatedPositions >= input.policy.maxOpenPositions) {
      reasonCodes.push("POSITION_CAP");
      explanation = "No portfolio position slot remains.";
    } else if (corr.unknown.length > 0 && input.policy.unknownCorrelationPolicy === "block") {
      reasonCodes.push("UNKNOWN_CORRELATION_BLOCKED");
      explanation = "Correlation is unmeasurable against an existing or reserved position and policy is fail-closed.";
    } else {
      let maxFraction = 1;
      const remainingRisk = maximumStopRisk - remainingStopRisk - input.initialReservedRisk - shadowReservedRisk;
      maxFraction = Math.min(maxFraction, remainingRisk / item.risk);
      if (remainingRisk <= 0) reasonCodes.push("PORTFOLIO_RISK_CAP");

      if (candidate.strategyId) {
        const strategyCap = maximumStopRisk * input.policy.maxStrategyRiskFraction;
        const remainingStrategyRisk = strategyCap - (strategyRisk.get(candidate.strategyId) ?? 0);
        maxFraction = Math.min(maxFraction, remainingStrategyRisk / item.risk);
        if (remainingStrategyRisk <= 0) reasonCodes.push("STRATEGY_RISK_CAP");
      }

      const existingSymbolNotional = exposures
        .filter((exposure) => exposure.symbol === candidate.symbol)
        .reduce((sum, exposure) => sum + exposure.notional, 0);
      const symbolRemaining = input.equity * input.policy.maxSymbolNotionalFraction - existingSymbolNotional;
      maxFraction = Math.min(maxFraction, symbolRemaining / item.notional);
      if (symbolRemaining <= 0) reasonCodes.push("SYMBOL_NOTIONAL_CAP");

      const signedNotional = candidate.side === "long" ? item.notional : -item.notional;
      const netCap = input.equity * input.policy.maxNetExposureFraction;
      const netScale = netExposureScale(runningNet, signedNotional, netCap);
      maxFraction = Math.min(maxFraction, netScale);
      if (netScale <= 0) reasonCodes.push("NET_EXPOSURE_CAP");

      const reinforcingNotional = corr.reinforcing.reduce((sum, exposure) => sum + exposure.notional, 0);
      const clusterRemaining = input.equity * input.policy.maxCorrelatedNotionalFraction - reinforcingNotional;
      maxFraction = Math.min(maxFraction, clusterRemaining / item.notional);
      if (clusterRemaining <= 0) reasonCodes.push("CORRELATED_EXPOSURE_CAP");

      allocationFraction = round(clamp01(maxFraction), 6);
      if (allocationFraction < input.policy.minimumAllocationFraction) {
        reasonCodes.push("ALLOCATION_BELOW_MINIMUM");
        explanation = "The remaining bounded allocation is below the policy minimum, so the portfolio retains cash.";
        allocationFraction = 0;
      } else {
        disposition = "SHADOW_ALLOCATED";
        reasonCodes.push(allocationFraction < 0.999999 ? "REDUCED_ALLOCATION" : "SHADOW_ALLOCATED");
        explanation = allocationFraction < 0.999999
          ? "The candidate is retained with a reduced Shadow allocation after portfolio constraints."
          : "The candidate fits the current Shadow portfolio budget.";
      }
    }

    const allocatedRisk = item.risk * allocationFraction;
    const allocatedNotional = item.notional * allocationFraction;
    const allocatedQuantity = (candidate.quantity ?? 0) * allocationFraction;
    if (disposition === "SHADOW_ALLOCATED" && candidate.side) {
      shadowReservedRisk += allocatedRisk;
      shadowAllocatedPositions++;
      runningNet += candidate.side === "long" ? allocatedNotional : -allocatedNotional;
      reservedExposures.push({
        symbol: candidate.symbol,
        side: candidate.side,
        strategyId: candidate.strategyId,
        notional: allocatedNotional,
        risk: allocatedRisk,
      });
      if (candidate.strategyId) {
        strategyRisk.set(candidate.strategyId, (strategyRisk.get(candidate.strategyId) ?? 0) + allocatedRisk);
      }
    }

    assessments.push({
      ...base,
      rank: index + 1,
      allocatedRisk: round(allocatedRisk),
      allocatedNotional: round(allocatedNotional),
      allocatedQuantity: round(allocatedQuantity, 8),
      allocationFraction,
      disposition,
      reasonCodes,
      explanation,
      correlationUnknownWith: corr.unknown,
      reinforcingClusterSymbols: [...new Set(corr.reinforcing.map((exposure) => exposure.symbol))].sort(),
    });
  }

  const remainingRisk = Math.max(
    0,
    maximumStopRisk - remainingStopRisk - input.initialReservedRisk - shadowReservedRisk,
  );
  const retainedReasons = new Set<string>(["SHADOW_CANNOT_EXECUTE"]);
  if (assessments.length === 0) retainedReasons.add("NO_CURRENT_OPPORTUNITIES");
  for (const assessment of assessments) {
    if (assessment.disposition !== "SHADOW_ALLOCATED") {
      for (const code of assessment.reasonCodes) retainedReasons.add(code);
    }
  }
  const sourceScanTimestamp = sourceTimes.length === 1 ? sourceTimes[0]! : null;
  const riskUsage = {
    maximumStopRisk: round(maximumStopRisk),
    openStopRisk: round(remainingStopRisk),
    initiallyReservedRisk: round(input.initialReservedRisk),
    shadowReservedRisk: round(shadowReservedRisk),
    remainingRisk: round(remainingRisk),
    drawdownScale: scale,
    openPositions: input.positions.length,
    shadowAllocatedPositions,
    remainingPositionSlots: Math.max(0, input.policy.maxOpenPositions - input.positions.length - shadowAllocatedPositions),
  };
  const retainedCash = {
    // Shadow mode moves no capital; all actual cash remains untouched.
    amount: round(input.availableBalance),
    fractionOfAvailableBalance: input.availableBalance > 0 ? 1 : 0,
    reasonCodes: [...retainedReasons].sort(),
    explanation: "All actual cash remains untouched because this projection cannot execute. Remaining risk budget is shown separately.",
  };
  const fingerprintBody = {
    portfolioVersion: PORTFOLIO_INTELLIGENCE_VERSION,
    contextFingerprint: context.fingerprint,
    policy: input.policy,
    opportunities: assessments,
    correlations: input.correlations,
    dataStatus: effectiveStatus,
    dataIssues,
    riskUsage,
    retainedCash,
  };
  const fingerprint = sha256Fingerprint(fingerprintBody);
  return deepFreeze({
    schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
    portfolioVersion: PORTFOLIO_INTELLIGENCE_VERSION,
    mode: "shadow",
    cannotExecute: true,
    projectionId: deterministicUuid({ fingerprint, type: "portfolio-projection" }),
    fingerprint,
    generatedAt: input.asOf,
    sourceScanTimestamp,
    dataStatus: effectiveStatus,
    dataIssues,
    policy: input.policy,
    context,
    riskUsage,
    opportunities: assessments,
    retainedCash,
  });
}
