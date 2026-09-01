import { timingSafeEqual } from "node:crypto";
import type { BotConfig } from "@workspace/db";
import { z } from "zod";
import type { ExecutionAuthority } from "../execution/authority";
import { sha256Fingerprint } from "../intelligence/canonical";
import type { Candle, MultiTimeframeCandles, SignalRow } from "../strategy";
import type { StrategyConfig, TradePlan } from "../strategies";
import type { DemoAutopilotMandate } from "./contracts";
import { globalAutopilotSuspended } from "./config";

export const PHASE10_VALIDATION_CONFIRMATION =
  "RUN_ONE_SIMULATED_DEMO_PHASE10_VALIDATION";
export const Phase10ValidationRunIdSchema = z.string().uuid();
export const Phase10ValidationStageSchema = z.enum([
  "entry",
  "manage",
  "verify",
  "close",
  "confirm-suspended",
]);

export type Phase10ValidationStage = z.infer<
  typeof Phase10ValidationStageSchema
>;

interface ValidationEnvironment {
  NODE_ENV?: string;
  AUTOPILOT_GLOBAL_SUSPENDED?: string;
  PHASE10_VALIDATION_ENABLED?: string;
  PHASE10_VALIDATION_TOKEN?: string;
}

export interface Phase10ValidationAuthorization {
  readonly runId: string;
  readonly operatorUserId: number;
  readonly authorizationFingerprint: string;
  readonly requiresGlobalSuspension: "inactive" | "active";
}

const issuedAuthorizations = new WeakSet<object>();

function equalSecret(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

/**
 * The deterministic path is unavailable unless an operator deliberately arms
 * both an environment gate and a high-entropy token for this exact process.
 * The token is read from the environment, never accepted on the command line.
 */
export function authorizePhase10Validation(input: {
  runId: string;
  operatorUserId: number;
  confirmation: string;
  token: string | undefined;
  requiresGlobalSuspension?: "inactive" | "active";
  environment?: ValidationEnvironment;
}): Phase10ValidationAuthorization {
  const environment = input.environment ?? process.env;
  const runId = Phase10ValidationRunIdSchema.parse(input.runId);
  if (!Number.isInteger(input.operatorUserId) || input.operatorUserId <= 0) {
    throw new Error("Phase 10 validation requires a positive operator user id");
  }
  if (input.confirmation !== PHASE10_VALIDATION_CONFIRMATION) {
    throw new Error(
      "Phase 10 validation confirmation did not match the required operator phrase",
    );
  }
  if (environment.PHASE10_VALIDATION_ENABLED?.trim().toLowerCase() !== "true") {
    throw new Error(
      "Phase 10 deterministic validation is not explicitly enabled for this process",
    );
  }
  const expectedToken = environment.PHASE10_VALIDATION_TOKEN?.trim() ?? "";
  const suppliedToken = input.token?.trim() ?? "";
  if (
    expectedToken.length < 32 ||
    suppliedToken.length < 32 ||
    !equalSecret(suppliedToken, expectedToken)
  ) {
    throw new Error("Phase 10 validation operator authorization was refused");
  }
  const requiresGlobalSuspension = input.requiresGlobalSuspension ?? "inactive";
  const suspended = globalAutopilotSuspended(environment);
  if (requiresGlobalSuspension === "inactive" ? suspended : !suspended) {
    throw new Error(
      requiresGlobalSuspension === "inactive"
        ? "Broker sandbox AutoPilot suspension must be explicitly false during the controlled validation stages"
        : "Broker sandbox AutoPilot suspension must be restored before validation completion can be confirmed",
    );
  }
  const authorization: Phase10ValidationAuthorization = Object.freeze({
    runId,
    operatorUserId: input.operatorUserId,
    requiresGlobalSuspension,
    authorizationFingerprint: sha256Fingerprint({
      runId,
      operatorUserId: input.operatorUserId,
      requiresGlobalSuspension,
      tokenFingerprint: sha256Fingerprint(expectedToken),
    }),
  });
  issuedAuthorizations.add(authorization);
  return authorization;
}

export function assertPhase10ValidationAuthorization(
  authorization: Phase10ValidationAuthorization,
  runId: string,
  operatorUserId: number,
): void {
  if (
    !issuedAuthorizations.has(authorization) ||
    authorization.runId !== Phase10ValidationRunIdSchema.parse(runId) ||
    authorization.operatorUserId !== operatorUserId
  ) {
    throw new Error(
      "Phase 10 validation capability is missing, expired, or belongs to another operator/run",
    );
  }
}

/** Categorical defense-in-depth boundary for the synthetic input path. */
export function assertSimulatedDemoValidationBoundary(input: {
  authority: ExecutionAuthority;
  config: BotConfig;
  mandate: DemoAutopilotMandate;
}): void {
  if (
    input.authority !== "simulated_demo" ||
    input.mandate.executionAuthority !== "simulated_demo" ||
    input.config.executionTarget !== "demo" ||
    input.config.mode !== "autopilot" ||
    input.config.positionManagementMode !== "phase7_active" ||
    input.config.marketType !== "spot" ||
    input.mandate.marketType !== "spot"
  ) {
    throw new Error(
      "Deterministic Phase 10 validation requires crypto Spot simulated_demo Autopilot with Phase 7 active management",
    );
  }
}

function frame(input: {
  observedAt: Date;
  intervalMs: number;
  closedCount: number;
  finalPrice: number;
  terminalHigh?: number;
  terminalLow?: number;
}): Candle[] {
  const slope = Math.max(input.finalPrice * 0.00002, 0.0001);
  const start =
    input.observedAt.getTime() - input.closedCount * input.intervalMs;
  const finalOpen = input.finalPrice - slope * 0.6;
  const firstOpen = finalOpen - input.closedCount * slope;
  const candles: Candle[] = [];
  for (let index = 0; index <= input.closedCount; index++) {
    const timestamp = start + index * input.intervalMs;
    const open = firstOpen + index * slope;
    const close = open + slope * 0.6;
    const normalHigh = Math.max(open, close) + slope * 2;
    const normalLow = Math.min(open, close) - slope * 2;
    const terminal = index === input.closedCount;
    candles.push([
      timestamp,
      open,
      terminal && input.terminalHigh != null
        ? Math.max(normalHigh, input.terminalHigh)
        : normalHigh,
      terminal && input.terminalLow != null
        ? Math.min(normalLow, input.terminalLow)
        : normalLow,
      terminal ? input.finalPrice : close,
      1_000 + index * 5,
    ]);
  }
  return candles;
}

export function buildPhase10ValidationCandles(input: {
  observedAt: Date;
  finalPrice: number;
  terminalHigh?: number;
  terminalLow?: number;
}): MultiTimeframeCandles {
  const common = {
    observedAt: input.observedAt,
    finalPrice: input.finalPrice,
  };
  return {
    tf1m: frame({
      ...common,
      intervalMs: 60_000,
      closedCount: 120,
      terminalHigh: input.terminalHigh,
      terminalLow: input.terminalLow,
    }),
    tf3m: frame({ ...common, intervalMs: 3 * 60_000, closedCount: 70 }),
    tf5m: frame({ ...common, intervalMs: 5 * 60_000, closedCount: 70 }),
    tf15m: frame({ ...common, intervalMs: 15 * 60_000, closedCount: 70 }),
    tf1h: frame({ ...common, intervalMs: 60 * 60_000, closedCount: 70 }),
  };
}

export function buildPhase10ValidationPlan(input: {
  authorization: Phase10ValidationAuthorization;
  symbol: string;
  strategyId: string;
  row: SignalRow;
  balanceUsdt: number;
  config: BotConfig;
  mandate: DemoAutopilotMandate;
  strategyConfig: StrategyConfig;
}): TradePlan {
  const entryPrice = input.row.lastPrice;
  const stopDistance = Math.max(entryPrice * 0.01, 0.0001);
  const configuredRiskUsdt =
    input.balanceUsdt * (Number(input.config.maxPortfolioRiskPercent) / 100);
  const mandatedRiskUsdt =
    input.balanceUsdt * (input.mandate.maximumPortfolioRiskPercent / 100);
  const notionalCaps = [
    Number(input.config.positionSizeUsdt),
    input.mandate.maximumPositionSizeUsdt,
    input.balanceUsdt * 0.5,
    input.balanceUsdt *
      (Number(input.config.maxSymbolConcentrationPercent) / 100) *
      0.5,
    input.balanceUsdt *
      (Number(input.config.maxNetExposurePercent) / 100) *
      0.5,
    input.balanceUsdt *
      (Number(input.config.maxCorrelatedExposurePercent) / 100) *
      0.5,
    input.balanceUsdt *
      (input.mandate.maximumSymbolExposurePercent / 100) *
      0.5,
    input.balanceUsdt * (input.mandate.maximumNetExposurePercent / 100) * 0.5,
    input.balanceUsdt *
      (input.mandate.maximumCorrelatedExposurePercent / 100) *
      0.5,
  ].filter((value) => Number.isFinite(value) && value > 0);
  const maximumNotional = Math.min(...notionalCaps);
  const maximumRisk = Math.min(configuredRiskUsdt, mandatedRiskUsdt) * 0.5;
  const quantity = Math.min(
    maximumNotional / entryPrice,
    maximumRisk / stopDistance,
  );
  if (!(entryPrice > 0) || !(quantity > 0) || !Number.isFinite(quantity)) {
    throw new Error(
      "The configured Demo mandate/risk limits cannot size one deterministic validation position",
    );
  }
  return {
    strategyId: input.strategyId,
    strategyName: `Phase 10 validation via ${input.strategyId}`,
    symbol: input.symbol,
    side: "long",
    confidence: 95,
    entryPrice,
    slPrice: entryPrice - stopDistance,
    tpPrice: entryPrice + stopDistance * 4,
    qty: quantity,
    leverage: 1,
    expectedHoldSeconds: Math.min(
      1_800,
      input.strategyConfig.maxHoldingSeconds,
    ),
    maxHoldSeconds: input.strategyConfig.maxHoldingSeconds,
    regime: input.row.regime,
    netRewardRisk: 4,
    report: {
      summary:
        "Operator-authorized deterministic Phase 10 simulated Demo validation decision",
      marketView: [
        "Synthetic fixture is explicitly labeled and restricted to the validation-only simulated_demo path",
      ],
      entryLogic: [
        "One deterministic Brain V0 decision was requested to validate the existing autonomous execution chain",
      ],
      riskLogic: [
        "Position size is bounded by the stricter configured and immutable mandate limits",
      ],
      exitLogic: [
        "The position is managed and closed only by the existing simulated Demo and Phase 7 paths",
      ],
      checks: [
        {
          name: "Validation authorization",
          passed: true,
          detail: input.authorization.authorizationFingerprint,
        },
        {
          name: "Simulated authority",
          passed: true,
          detail: "simulated_demo only",
        },
      ],
      data: {
        phase10ValidationRunId: input.authorization.runId,
        phase10ValidationSource: "operator-authorized-deterministic-fixture",
      },
    },
  };
}

export function phase10ManagementProjection(trade: {
  remainingQuantity: string | null;
  stopLoss: string;
  tp1Filled: boolean;
  tp2Filled: boolean;
  breakEvenActive: boolean;
  trailingStopActive: boolean;
  trailingStopMode: string | null;
  trailingStopArmedPrice: string | null;
  mfeUsdt: string | null;
  maeUsdt: string | null;
}) {
  const projection = {
    remainingQuantity: trade.remainingQuantity,
    stopLoss: trade.stopLoss,
    tp1Filled: trade.tp1Filled,
    tp2Filled: trade.tp2Filled,
    breakEvenActive: trade.breakEvenActive,
    trailingStopActive: trade.trailingStopActive,
    trailingStopMode: trade.trailingStopMode,
    trailingStopArmedPrice: trade.trailingStopArmedPrice,
    mfeUsdt: trade.mfeUsdt,
    maeUsdt: trade.maeUsdt,
  };
  return { projection, fingerprint: sha256Fingerprint(projection) };
}
