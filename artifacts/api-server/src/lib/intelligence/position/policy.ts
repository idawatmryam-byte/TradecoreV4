import { randomUUID } from "node:crypto";
import { sha256Fingerprint } from "../canonical";
import type { MarketState } from "../market-state/types";
import type { PositionSnapshot } from "./evaluator";
import {
  POSITION_POLICY_VERSION,
  parsePositionActionValidation,
  parsePositionManagementAction,
  type PositionActionValidation,
  type PositionManagementAction,
  type PositionManagementActionType,
  type PositionThesis,
  type PositionThesisEvaluation,
} from "./types";

export const PHASE7_POLICY = Object.freeze({
  version: POSITION_POLICY_VERSION,
  targetDegradedReductionFraction: 0.5,
  minimumProgressRForBreakEven: 0.25,
  minimumProgressRForTrailing: 1,
  trailingAtrMultiplier: 2,
});

export interface ProposePositionActionInput {
  thesis: PositionThesis;
  evaluation: PositionThesisEvaluation;
  position: PositionSnapshot;
  marketState: MarketState | null;
  reductionAlreadyApplied: boolean;
  proposedAt: Date;
  actionId?: string;
}

function trailingStop(
  position: PositionSnapshot,
  marketState: MarketState,
): number {
  const distance =
    marketState.observations.volatility.atr *
    PHASE7_POLICY.trailingAtrMultiplier;
  const raw =
    position.side === "long"
      ? marketState.observations.lastPrice - distance
      : marketState.observations.lastPrice + distance;
  return position.side === "long"
    ? Math.max(position.currentStopPrice, raw)
    : Math.min(position.currentStopPrice, raw);
}

export function proposePositionAction(
  input: ProposePositionActionInput,
): PositionManagementAction {
  const { thesis, evaluation, position, marketState } = input;
  let type: PositionManagementActionType = "HOLD";
  let proposedStopPrice: number | null = null;
  let reductionFraction: number | null = null;
  let trailingMode: "atr" | null = null;
  const reasonCodes = [...evaluation.reasonCodes];

  if (evaluation.state === "DATA_UNCERTAIN") {
    type = "FREEZE";
  } else if (evaluation.state === "INVALIDATED") {
    type = "EXIT";
  } else if (
    evaluation.state === "TARGET_DEGRADED" &&
    !input.reductionAlreadyApplied
  ) {
    type = "REDUCE";
    reductionFraction = PHASE7_POLICY.targetDegradedReductionFraction;
  } else if (
    evaluation.state === "WEAKENING" &&
    evaluation.progressR >= PHASE7_POLICY.minimumProgressRForBreakEven
  ) {
    type = "TIGHTEN_STOP";
    proposedStopPrice = position.entryPrice;
  } else if (
    evaluation.state === "VALID" &&
    evaluation.progressR >= PHASE7_POLICY.minimumProgressRForTrailing &&
    marketState
  ) {
    type = "APPLY_TRAILING";
    proposedStopPrice = trailingStop(position, marketState);
    trailingMode = "atr";
  }

  const core = {
    schemaVersion: "position-management-action-v1" as const,
    actionId: input.actionId ?? randomUUID(),
    thesisId: thesis.thesisId,
    tradeId: position.tradeId,
    type,
    state: evaluation.state,
    policyVersion: POSITION_POLICY_VERSION,
    proposedStopPrice,
    reductionFraction,
    trailingMode,
    reasonCodes: reasonCodes.length ? reasonCodes : ["NO_ACTION_REQUIRED"],
    marketStateFingerprint: marketState?.fingerprint ?? null,
    proposedAt: input.proposedAt.toISOString(),
  };
  const {
    actionId: _actionId,
    proposedAt: _proposedAt,
    ...fingerprintCore
  } = core;
  return parsePositionManagementAction({
    ...core,
    fingerprint: sha256Fingerprint(fingerprintCore),
  });
}

export function validatePositionAction(
  action: PositionManagementAction,
  thesis: PositionThesis,
  position: PositionSnapshot,
  currentPrice: number,
  validatedAt: Date,
): PositionActionValidation {
  const reasons: string[] = [];
  const initialRiskPerUnit = Math.abs(
    position.entryPrice - thesis.entry.initialStopPrice,
  );
  const currentRiskPerUnit =
    position.side === "long"
      ? Math.max(0, position.entryPrice - position.currentStopPrice)
      : Math.max(0, position.currentStopPrice - position.entryPrice);
  let proposedRiskPerUnit = currentRiskPerUnit;
  const priceRequired = action.type !== "FREEZE";
  let valid =
    (!priceRequired || (Number.isFinite(currentPrice) && currentPrice > 0)) &&
    position.remainingQuantity > 0;
  if (!valid) reasons.push("POSITION_OR_PRICE_INVALID");
  if (!thesis.permittedActions.includes(action.type)) {
    valid = false;
    reasons.push("ACTION_NOT_PERMITTED_BY_THESIS");
  }

  if (action.type === "TIGHTEN_STOP" || action.type === "APPLY_TRAILING") {
    const stop = action.proposedStopPrice;
    const geometryValid =
      stop !== null &&
      Number.isFinite(stop) &&
      (position.side === "long"
        ? stop >= position.currentStopPrice && stop < currentPrice
        : stop <= position.currentStopPrice && stop > currentPrice);
    if (!geometryValid) {
      valid = false;
      reasons.push("STOP_GEOMETRY_NOT_RISK_REDUCING");
    } else {
      proposedRiskPerUnit =
        position.side === "long"
          ? Math.max(0, position.entryPrice - stop!)
          : Math.max(0, stop! - position.entryPrice);
    }
  }
  if (action.type === "REDUCE") {
    if (
      !(
        action.reductionFraction !== null &&
        action.reductionFraction > 0 &&
        action.reductionFraction <=
          PHASE7_POLICY.targetDegradedReductionFraction
      )
    ) {
      valid = false;
      reasons.push("REDUCTION_OUTSIDE_POLICY");
    }
  }
  if (action.type === "EXIT" && action.state !== "INVALIDATED") {
    valid = false;
    reasons.push("EXIT_REQUIRES_INVALIDATED_THESIS");
  }
  const currentMaximumLoss =
    Math.min(initialRiskPerUnit, currentRiskPerUnit) *
    position.remainingQuantity;
  const remainingFraction =
    action.type === "REDUCE"
      ? 1 - (action.reductionFraction ?? 0)
      : action.type === "EXIT"
        ? 0
        : 1;
  const proposedMaximumLoss =
    proposedRiskPerUnit * position.remainingQuantity * remainingFraction;
  if (proposedMaximumLoss > currentMaximumLoss + 1e-8) {
    valid = false;
    reasons.push("MAXIMUM_LOSS_WOULD_INCREASE");
  }
  if (valid) reasons.push("DETERMINISTIC_POLICY_VALIDATED");

  const core = {
    schemaVersion: "position-action-validation-v1" as const,
    actionFingerprint: action.fingerprint,
    valid,
    currentMaximumLoss,
    proposedMaximumLoss,
    reasonCodes: reasons.length ? reasons : ["VALIDATION_FAILED_CLOSED"],
    validatedAt: validatedAt.toISOString(),
  };
  return parsePositionActionValidation({
    ...core,
    fingerprint: sha256Fingerprint(core),
  });
}
