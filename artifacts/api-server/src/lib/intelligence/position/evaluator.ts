import { sha256Fingerprint } from "../canonical";
import type { MarketState } from "../market-state/types";
import {
  parsePositionThesisEvaluation,
  type PositionThesis,
  type PositionThesisEvaluation,
  type PositionThesisState,
} from "./types";

export interface PositionSnapshot {
  tradeId: number;
  symbol: string;
  side: "long" | "short";
  entryPrice: number;
  currentStopPrice: number;
  targetPrice: number;
  remainingQuantity: number;
  openedAt: Date;
}

export interface EvaluatePositionThesisInput {
  thesis: PositionThesis;
  position: PositionSnapshot;
  marketState: MarketState | null;
  evaluatedAt: Date;
}

export function evaluatePositionThesis(
  input: EvaluatePositionThesisInput,
): PositionThesisEvaluation {
  const { thesis, position, marketState, evaluatedAt } = input;
  const supportingEvidence: string[] = [];
  const contraryEvidence: string[] = [];
  const reasonCodes: string[] = [];
  const riskDistance = Math.abs(
    thesis.entry.price - thesis.entry.initialStopPrice,
  );
  const currentPrice =
    marketState?.observations.lastPrice ?? position.entryPrice;
  const progressR =
    riskDistance > 0
      ? (position.side === "long"
          ? currentPrice - position.entryPrice
          : position.entryPrice - currentPrice) / riskDistance
      : 0;
  const elapsedSeconds = Math.max(
    0,
    (evaluatedAt.getTime() - position.openedAt.getTime()) / 1000,
  );
  const elapsedFraction = elapsedSeconds / thesis.expectedDurationSeconds;
  let state: PositionThesisState;

  const structurallyInvalid =
    position.symbol !== thesis.symbol ||
    position.side !== thesis.side ||
    !Number.isFinite(position.entryPrice) ||
    !Number.isFinite(position.currentStopPrice) ||
    !Number.isFinite(position.targetPrice) ||
    !Number.isFinite(position.remainingQuantity) ||
    !(position.remainingQuantity > 0) ||
    !Number.isFinite(evaluatedAt.getTime());
  const uncertain =
    structurallyInvalid ||
    !marketState ||
    marketState.symbol !== thesis.symbol ||
    marketState.freshness.status !== "fresh" ||
    marketState.dataQuality.status !== "healthy" ||
    !Number.isFinite(marketState.observations.lastPrice);

  if (uncertain) {
    state = "DATA_UNCERTAIN";
    reasonCodes.push(
      structurallyInvalid
        ? "POSITION_DATA_INVALID"
        : !marketState
          ? "MARKET_STATE_MISSING"
          : "MARKET_STATE_UNCERTAIN",
    );
    contraryEvidence.push(
      "Adaptive management is frozen because required position or market data is not trustworthy.",
    );
  } else {
    const against = position.side === "long" ? "bearish" : "bullish";
    const opposing = marketState.inferences.dominantDirection === against;
    const aligned = marketState.observations.trend.alignedTimeframes;
    const stopViolated =
      position.side === "long"
        ? currentPrice <= thesis.entry.initialStopPrice
        : currentPrice >= thesis.entry.initialStopPrice;
    const durationExceeded = elapsedSeconds >= thesis.maximumDurationSeconds;
    if (stopViolated || (opposing && aligned >= 3) || durationExceeded) {
      state = "INVALIDATED";
      if (stopViolated) reasonCodes.push("INITIAL_INVALIDATION_PRICE_BREACHED");
      if (opposing && aligned >= 3)
        reasonCodes.push("STRONG_DIRECTIONAL_OPPOSITION");
      if (durationExceeded) reasonCodes.push("MAXIMUM_DURATION_EXCEEDED");
      contraryEvidence.push(
        "The persisted invalidation or maximum-duration policy has been met.",
      );
    } else if (
      (elapsedFraction >= 1 && progressR < 0.25) ||
      (opposing && aligned >= 2)
    ) {
      state = "TARGET_DEGRADED";
      reasonCodes.push(
        elapsedFraction >= 1
          ? "EXPECTED_PATH_NOT_PROGRESSING"
          : "TARGET_DIRECTION_DEGRADED",
      );
      contraryEvidence.push(
        "The target remains possible, but its expected path or timing has materially degraded.",
      );
    } else if (
      opposing ||
      marketState.inferences.anomaly.detected ||
      (elapsedFraction >= 0.5 && progressR < 0)
    ) {
      state = "WEAKENING";
      reasonCodes.push(
        opposing
          ? "DIRECTIONAL_OPPOSITION"
          : marketState.inferences.anomaly.detected
            ? "MARKET_ANOMALY"
            : "NEGATIVE_PROGRESS",
      );
      contraryEvidence.push(
        "Contrary evidence is present but has not crossed the invalidation threshold.",
      );
    } else {
      state = "VALID";
      reasonCodes.push("THESIS_REMAINS_VALID");
      supportingEvidence.push(
        "Fresh market state remains within the persisted thesis and duration boundaries.",
      );
    }
  }

  const core = {
    schemaVersion: "position-thesis-evaluation-v1" as const,
    thesisId: thesis.thesisId,
    tradeId: position.tradeId,
    state,
    marketStateFingerprint: marketState?.fingerprint ?? null,
    evaluatedAt: evaluatedAt.toISOString(),
    progressR,
    elapsedFraction,
    supportingEvidence,
    contraryEvidence,
    reasonCodes,
  };
  return parsePositionThesisEvaluation({
    ...core,
    fingerprint: sha256Fingerprint(core),
  });
}
