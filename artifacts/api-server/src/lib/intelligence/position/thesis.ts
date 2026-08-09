import { randomUUID } from "node:crypto";
import type { TradePlan } from "../../strategies";
import { sha256Fingerprint } from "../canonical";
import type { MarketState } from "../market-state/types";
import {
  POSITION_POLICY_VERSION,
  POSITION_THESIS_VERSION,
  parsePositionThesis,
  type PositionThesis,
} from "./types";

export interface BuildPositionThesisInput {
  plan: TradePlan;
  marketState: MarketState;
  createdAt: Date;
  thesisId?: string;
}

export function buildPositionThesis(
  input: BuildPositionThesisInput,
): PositionThesis {
  const { plan, marketState } = input;
  if (plan.symbol !== marketState.symbol)
    throw new Error("Trade plan and MarketState symbols do not match");
  const thesisId = input.thesisId ?? randomUUID();
  const core = {
    schemaVersion: POSITION_THESIS_VERSION,
    thesisId,
    symbol: plan.symbol,
    side: plan.side,
    context: plan.report.marketView.join(" ") || plan.report.summary,
    trigger: plan.report.entryLogic.join(" ") || plan.report.summary,
    invalidationConditions: [
      `Price violates the protected stop at ${plan.slPrice}`,
      `At least three observed timeframes align against the ${plan.side} thesis`,
    ],
    targetRationale:
      plan.report.exitLogic.join(" ") || `Target remains ${plan.tpPrice}`,
    expectedPath: [
      `Price progresses from ${plan.entryPrice} toward ${plan.tpPrice}`,
      `The dominant market direction does not become strongly opposed`,
      `The thesis resolves within ${plan.maxHoldSeconds} seconds`,
    ],
    expectedDurationSeconds: Math.max(1, Math.round(plan.expectedHoldSeconds)),
    maximumDurationSeconds: Math.max(
      Math.round(plan.expectedHoldSeconds),
      Math.round(plan.maxHoldSeconds),
    ),
    managementPolicyVersion: POSITION_POLICY_VERSION,
    permittedActions: [
      "HOLD",
      "REDUCE",
      "TIGHTEN_STOP",
      "APPLY_TRAILING",
      "EXIT",
      "FREEZE",
    ] as const,
    entry: {
      price: plan.entryPrice,
      initialStopPrice: plan.slPrice,
      targetPrice: plan.tpPrice,
      regime: marketState.inferences.regime,
      dominantDirection: marketState.inferences.dominantDirection,
      marketStateFingerprint: marketState.fingerprint,
      marketStateVersion: marketState.marketStateVersion,
      dataTimestamp: marketState.dataTimestamp,
    },
    createdAt: input.createdAt.toISOString(),
  };
  return parsePositionThesis({ ...core, fingerprint: sha256Fingerprint(core) });
}
