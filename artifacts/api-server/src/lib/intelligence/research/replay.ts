import type {
  Strategy,
  StrategyConfig,
  TradePlan,
  TradeRejection,
} from "../../strategies";
import { sha256Fingerprint } from "../canonical";
import {
  aggregateDecisionCouncil,
  type HistoricalEvidenceContext,
} from "../council";
import type { MarketState } from "../market-state/types";
import {
  buildPortfolioIntelligence,
  type PairCorrelationInput,
  type PortfolioIntelligenceProjection,
  type PortfolioPolicy,
  type PortfolioPositionInput,
} from "../portfolio";
import {
  evaluatePositionThesis,
  proposePositionAction,
  validatePositionAction,
  type PositionSnapshot,
  type PositionThesis,
} from "../position";
import { buildSpecialistCouncilSnapshot } from "../specialists";
import {
  RESEARCH_REPLAY_VERSION,
  parseResearchDecisionEvent,
  parseResearchManagementEvent,
  type ResearchDecisionEvent,
  type ResearchManagementEvent,
} from "./types";

export interface ResearchSymbolFrame {
  marketState: MarketState;
  strategies: readonly Strategy[];
  configs: ReadonlyMap<string, StrategyConfig>;
  plans: readonly TradePlan[];
  rejections: readonly TradeRejection[];
  historicalEvidence: HistoricalEvidenceContext;
}

export interface ResearchPositionFrame {
  thesis: PositionThesis;
  position: PositionSnapshot;
  reductionAlreadyApplied: boolean;
}

export interface ResearchPortfolioFrame {
  currency: string;
  equity: number;
  availableBalance: number;
  drawdownFraction: number;
  initialReservedRisk: number;
  positions: readonly PortfolioPositionInput[];
  correlations: readonly PairCorrelationInput[];
  policy: PortfolioPolicy;
  dataStatus?: "healthy" | "degraded" | "blocked";
  dataIssues?: readonly string[];
}

export interface ReplayFullBrainFrameInput {
  experimentId: string;
  partitionId: string;
  sequenceStart: number;
  observedAt: Date;
  maximumCandidateAgeMs: number;
  feeRatePerLeg: number;
  slippageRatePerLeg: number;
  costModelVersion: string;
  symbols: readonly ResearchSymbolFrame[];
  portfolio: ResearchPortfolioFrame;
  managedPositions?: readonly ResearchPositionFrame[];
}

export interface FullBrainFrameReplay {
  mode: "research";
  cannotExecute: true;
  observedAt: string;
  decisions: readonly ResearchDecisionEvent[];
  management: readonly ResearchManagementEvent[];
  portfolio: PortfolioIntelligenceProjection;
  fingerprint: string;
}

function assertPointInTime(
  frame: ResearchSymbolFrame,
  observedAt: number,
): void {
  const state = frame.marketState;
  const dataTimestamp = Date.parse(state.dataTimestamp);
  const stateObservedAt = Date.parse(state.observedAt);
  if (!Number.isFinite(dataTimestamp) || !Number.isFinite(stateObservedAt)) {
    throw new Error(`MarketState for ${state.symbol} has invalid timestamps`);
  }
  if (dataTimestamp > observedAt || stateObservedAt > observedAt) {
    throw new Error(`MarketState for ${state.symbol} contains future data`);
  }
  if (
    state.freshness.status !== "fresh" ||
    state.dataQuality.status !== "healthy"
  ) {
    throw new Error(
      `MarketState for ${state.symbol} is not eligible for full-brain replay`,
    );
  }
  for (const item of frame.historicalEvidence.items) {
    if (Date.parse(item.dataCutoff) > observedAt) {
      throw new Error(
        `Evidence ${item.evidenceId} contains a future data cutoff`,
      );
    }
  }
}

function outcomeOf(
  disposition: ResearchDecisionEvent["portfolio"]["disposition"],
  expiresAt: string,
  observedAt: number,
): ResearchDecisionEvent["outcome"] {
  if (Date.parse(expiresAt) <= observedAt) return "EXPIRED";
  if (disposition === "SHADOW_ALLOCATED") return "TRADE_CANDIDATE";
  if (disposition === "WAIT_FOR_TRIGGER") return "WAITING";
  if (disposition === "OBSERVE") return "OBSERVED";
  return "REJECTED";
}

export function replayFullBrainFrame(
  input: ReplayFullBrainFrameInput,
): FullBrainFrameReplay {
  const observedAtMs = input.observedAt.getTime();
  if (!Number.isFinite(observedAtMs))
    throw new Error("Research replay observedAt is invalid");
  if (!Number.isInteger(input.sequenceStart) || input.sequenceStart < 0)
    throw new Error("Research replay sequence must be non-negative");
  if (!(input.maximumCandidateAgeMs > 0))
    throw new Error("Maximum candidate age must be positive");
  if (input.symbols.length === 0)
    throw new Error("Full-brain replay requires at least one symbol frame");
  const orderedFrames = [...input.symbols].sort((a, b) =>
    a.marketState.symbol.localeCompare(b.marketState.symbol),
  );
  const seenSymbols = new Set<string>();
  for (const frame of orderedFrames) {
    if (seenSymbols.has(frame.marketState.symbol))
      throw new Error(`Duplicate symbol frame ${frame.marketState.symbol}`);
    seenSymbols.add(frame.marketState.symbol);
    assertPointInTime(frame, observedAtMs);
  }

  const evaluated = orderedFrames.map((frame) => {
    const specialist = buildSpecialistCouncilSnapshot({
      marketState: frame.marketState,
      strategies: frame.strategies,
      configs: frame.configs,
      plans: frame.plans,
      rejections: frame.rejections,
      generatedAt: input.observedAt,
    });
    const council = aggregateDecisionCouncil({
      marketState: frame.marketState,
      specialistCouncil: specialist,
      brainV0Plans: frame.plans,
      executionCosts: {
        feeRatePerLeg: input.feeRatePerLeg,
        slippageRatePerLeg: input.slippageRatePerLeg,
        source: "engine-market-cost-model",
        version: input.costModelVersion,
      },
      portfolio: {
        status: "partial",
        currency: input.portfolio.currency,
        availableBalance: input.portfolio.availableBalance,
        openPositionCount: input.portfolio.positions.length,
        observedAt: input.observedAt.toISOString(),
        limitations: [
          "Authoritative same-scan allocation follows this deterministic council stage.",
        ],
      },
      historicalEvidence: frame.historicalEvidence,
      generatedAt: input.observedAt.toISOString(),
    });
    return { frame, specialist, council };
  });

  const opportunities = evaluated.map(({ frame, council }) => {
    const plan = council.decision.proposedTrade;
    return {
      decisionId: council.decision.decisionId,
      generatedAt: input.observedAt.toISOString(),
      dataTimestamp: council.decision.dataTimestamp,
      expiresAt: council.decision.expiresAt,
      symbol: council.decision.symbol,
      side: plan?.side ?? null,
      action: council.decision.action,
      strategyId:
        plan?.strategyId ?? council.brainV0.topCandidate?.strategyId ?? null,
      strategyName:
        plan?.strategyName ??
        council.brainV0.topCandidate?.strategyName ??
        null,
      entryPrice: plan?.entryPrice ?? null,
      stopPrice: plan?.stopPrice ?? null,
      targetPrice: plan?.targetPrice ?? null,
      quantity: plan?.quantity ?? null,
      netRewardRisk: plan?.netRewardRisk ?? null,
      uncertainty: council.decision.uncertainty.score,
      decisionStrength: council.assessment.decisionStrength,
      regimeSuitability: council.assessment.regimeSuitability,
      costPenalty: council.assessment.costPenalty,
      liquidityProxy: frame.marketState.observations.liquidity.proxyStatus,
      sourceFingerprint: council.decisionFingerprint,
    };
  });

  const projection = buildPortfolioIntelligence({
    asOf: input.observedAt.toISOString(),
    maximumCandidateAgeMs: input.maximumCandidateAgeMs,
    currency: input.portfolio.currency,
    equity: input.portfolio.equity,
    availableBalance: input.portfolio.availableBalance,
    drawdownFraction: input.portfolio.drawdownFraction,
    initialReservedRisk: input.portfolio.initialReservedRisk,
    positions: input.portfolio.positions,
    opportunities,
    correlations: input.portfolio.correlations,
    policy: input.portfolio.policy,
    dataStatus: input.portfolio.dataStatus ?? "healthy",
    dataIssues: input.portfolio.dataIssues ?? [],
  });

  const assessmentByDecision = new Map(
    projection.opportunities.map((assessment) => [
      assessment.decisionId,
      assessment,
    ]),
  );
  const decisions = evaluated.map(({ frame, specialist, council }, index) => {
    const assessment = assessmentByDecision.get(council.decision.decisionId);
    if (!assessment)
      throw new Error(
        `Portfolio projection omitted decision ${council.decision.decisionId}`,
      );
    const topControl = council.brainV0.topCandidate;
    const core = {
      schemaVersion: RESEARCH_REPLAY_VERSION,
      experimentId: input.experimentId,
      sequence: input.sequenceStart + index,
      partitionId: input.partitionId,
      observedAt: input.observedAt.toISOString(),
      dataTimestamp: frame.marketState.dataTimestamp,
      symbol: frame.marketState.symbol,
      marketStateFingerprint: frame.marketState.fingerprint,
      specialist: {
        stance: specialist.consensus.stance,
        opinionIds: specialist.opinions.map((item) => item.opinion.opinionId),
        actionableOpinions: specialist.consensus.actionableOpinions,
        abstentions: specialist.consensus.abstentions,
      },
      evidence: {
        status: frame.historicalEvidence.status,
        ruleVersion: frame.historicalEvidence.ruleVersion,
        evidenceIds: frame.historicalEvidence.items.map(
          (item) => item.evidenceId,
        ),
      },
      control: {
        action: topControl ? ("ENTER_NOW" as const) : ("OBSERVE" as const),
        candidateCount: council.brainV0.candidateCount,
        strategyId: topControl?.strategyId ?? null,
      },
      council: {
        decisionId: council.decision.decisionId,
        decisionFingerprint: council.decisionFingerprint,
        strategyId: council.decision.proposedTrade?.strategyId ?? null,
        action: council.decision.action,
        reasonCode: council.decision.reasonCode,
        decisionStrength: council.assessment.decisionStrength,
        uncertainty: council.decision.uncertainty.score,
      },
      portfolio: {
        projectionFingerprint: projection.fingerprint,
        disposition: assessment.disposition,
        rank: assessment.rank,
        allocationFraction: assessment.allocationFraction,
        reasonCodes: assessment.reasonCodes,
      },
      outcome: outcomeOf(
        assessment.disposition,
        council.decision.expiresAt,
        observedAtMs,
      ),
      cannotExecute: true as const,
    };
    return parseResearchDecisionEvent({
      ...core,
      fingerprint: sha256Fingerprint(core),
    });
  });

  const marketStateBySymbol = new Map(
    orderedFrames.map((frame) => [frame.marketState.symbol, frame.marketState]),
  );
  const management = [...(input.managedPositions ?? [])]
    .sort((a, b) => a.position.tradeId - b.position.tradeId)
    .map((managed, index) => {
      const marketState =
        marketStateBySymbol.get(managed.position.symbol) ?? null;
      const evaluation = evaluatePositionThesis({
        thesis: managed.thesis,
        position: managed.position,
        marketState,
        evaluatedAt: input.observedAt,
      });
      const action = proposePositionAction({
        thesis: managed.thesis,
        evaluation,
        position: managed.position,
        marketState,
        reductionAlreadyApplied: managed.reductionAlreadyApplied,
        proposedAt: input.observedAt,
      });
      const validation = validatePositionAction(
        action,
        managed.thesis,
        managed.position,
        marketState?.observations.lastPrice ?? managed.position.entryPrice,
        input.observedAt,
      );
      const core = {
        schemaVersion: RESEARCH_REPLAY_VERSION,
        experimentId: input.experimentId,
        sequence: input.sequenceStart + decisions.length + index,
        partitionId: input.partitionId,
        observedAt: input.observedAt.toISOString(),
        tradeId: managed.position.tradeId,
        symbol: managed.position.symbol,
        thesisFingerprint: managed.thesis.fingerprint,
        state: evaluation.state,
        proposedAction: action.type,
        actionFingerprint: action.fingerprint,
        proposedStopPrice: action.proposedStopPrice,
        reductionFraction: action.reductionFraction,
        validationFingerprint: validation.fingerprint,
        valid: validation.valid,
        currentMaximumLoss: validation.currentMaximumLoss,
        proposedMaximumLoss: validation.proposedMaximumLoss,
        cannotExecute: true as const,
      };
      return parseResearchManagementEvent({
        ...core,
        fingerprint: sha256Fingerprint(core),
      });
    });

  const frameCore = {
    version: RESEARCH_REPLAY_VERSION,
    experimentId: input.experimentId,
    partitionId: input.partitionId,
    observedAt: input.observedAt.toISOString(),
    decisionFingerprints: decisions.map((event) => event.fingerprint),
    managementFingerprints: management.map((event) => event.fingerprint),
    portfolioFingerprint: projection.fingerprint,
  };
  return Object.freeze({
    mode: "research",
    cannotExecute: true,
    observedAt: input.observedAt.toISOString(),
    decisions: Object.freeze(decisions),
    management: Object.freeze(management),
    portfolio: projection,
    fingerprint: sha256Fingerprint(frameCore),
  });
}
