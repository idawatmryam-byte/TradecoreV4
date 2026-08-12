import type { StrategyConfig, TradePlan } from "../strategies";
import { sha256Fingerprint } from "../intelligence/canonical";
import type { RiskCheck } from "../decisionTrace";

export interface AutopilotConfigIdentity {
  id: number;
  userId: number;
  section: string;
  broker: string;
  marketType: string;
  executionTarget: string;
  testnet: boolean;
  mode: string;
  positionManagementMode: string;
  positionSizeUsdt: string;
  riskPercent: string;
  maxOpenPositions: number;
  maxPortfolioRiskPercent: string;
  dailyLossLimitUsdt: string;
  maxSymbolConcentrationPercent: string;
  maxNetExposurePercent: string;
  maxCorrelatedExposurePercent: string;
  correlationThreshold: string;
  correlationUnknownPolicy: string;
  confidenceThreshold: number;
  riskModel: string;
  stopLossPercent: string;
  takeProfitPercent: string;
  maxLossUsdt: string;
  targetProfitUsdt: string;
  cooldownMinutes: number;
  scanIntervalSeconds: number;
  demoStartingBalanceUsdt: string;
  backtestMode: boolean;
  highFrequencyTestMode: boolean;
  leverage: number;
  marginMode: string;
  pairs: string;
}

/** Exact safety/execution identity frozen into a mandate. */
export function autopilotConfigFingerprint(config: AutopilotConfigIdentity): string {
  return sha256Fingerprint({
    id: config.id,
    userId: config.userId,
    section: config.section,
    broker: config.broker,
    marketType: config.marketType,
    executionTarget: config.executionTarget,
    testnet: config.testnet,
    mode: config.mode,
    positionManagementMode: config.positionManagementMode,
    positionSizeUsdt: config.positionSizeUsdt,
    riskPercent: config.riskPercent,
    maxOpenPositions: config.maxOpenPositions,
    maxPortfolioRiskPercent: config.maxPortfolioRiskPercent,
    dailyLossLimitUsdt: config.dailyLossLimitUsdt,
    maxSymbolConcentrationPercent: config.maxSymbolConcentrationPercent,
    maxNetExposurePercent: config.maxNetExposurePercent,
    maxCorrelatedExposurePercent: config.maxCorrelatedExposurePercent,
    correlationThreshold: config.correlationThreshold,
    correlationUnknownPolicy: config.correlationUnknownPolicy,
    confidenceThreshold: config.confidenceThreshold,
    riskModel: config.riskModel,
    stopLossPercent: config.stopLossPercent,
    takeProfitPercent: config.takeProfitPercent,
    maxLossUsdt: config.maxLossUsdt,
    targetProfitUsdt: config.targetProfitUsdt,
    cooldownMinutes: config.cooldownMinutes,
    scanIntervalSeconds: config.scanIntervalSeconds,
    demoStartingBalanceUsdt: config.demoStartingBalanceUsdt,
    backtestMode: config.backtestMode,
    highFrequencyTestMode: config.highFrequencyTestMode,
    leverage: config.leverage,
    marginMode: config.marginMode,
    pairs: config.pairs.split(",").map((item) => item.trim()).filter(Boolean).sort(),
  });
}

/** No fabricated strategy semver: version the actual plan-producing config. */
export function strategyConfigVersion(strategyId: string, config?: StrategyConfig): string {
  return `strategy-config:${sha256Fingerprint({ strategyId, config: config ?? null })}`;
}

export function riskDecisionFingerprint(input: {
  plan: TradePlan;
  checks: readonly RiskCheck[];
  portfolioRiskPercent: number;
  symbolExposurePercent: number;
  netExposurePercent: number;
  correlatedExposurePercent: number;
}): string {
  return sha256Fingerprint(input);
}

export function autonomousIdempotencyKey(input: {
  userId: number;
  section: string;
  mandateFingerprint: string;
  decisionFingerprint: string;
}): string {
  return `phase10:${sha256Fingerprint(input)}`;
}
