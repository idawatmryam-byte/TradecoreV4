import { z } from "zod";
import { sha256Fingerprint } from "../intelligence/canonical";
import type { ExecutionAuthority } from "../execution/authority";

export const DEMO_AUTOPILOT_SCHEMA_VERSION = "phase10-demo-autopilot-v1" as const;

export const DemoAutopilotAuthoritySchema = z.enum([
  "simulated_demo",
  "binance_spot_testnet",
  "binance_futures_demo",
  "oanda_practice",
]);

export const BrainVersionStateSchema = z.enum([
  "DRAFT",
  "RESEARCH",
  "SHADOW",
  "COPILOT",
  "DEMO_APPROVED",
  "LIVE_RESTRICTED",
  "SUSPENDED",
  "RETIRED",
]);

export const AutopilotStateSchema = z.enum([
  "AUTOPILOT_ENABLED",
  "AUTOPILOT_PAUSED",
  "AUTOPILOT_BLOCKED",
]);

export const Phase7MandateActionSchema = z.enum([
  "HOLD",
  "FREEZE",
  "REDUCE",
  "TIGHTEN_STOP",
  "APPLY_TRAILING",
  "EXIT",
]);

export const TradingWindowSchema = z.object({
  daysOfWeekUtc: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  startMinuteUtc: z.number().int().min(0).max(1439),
  endMinuteUtc: z.number().int().min(1).max(1440),
}).strict().refine((window) => window.endMinuteUtc > window.startMinuteUtc, {
  message: "endMinuteUtc must be after startMinuteUtc",
});

const DemoAutopilotMandateFieldsSchema = z.object({
  schemaVersion: z.literal(DEMO_AUTOPILOT_SCHEMA_VERSION),
  userId: z.number().int().positive(),
  section: z.enum(["crypto", "forex"]),
  version: z.number().int().positive(),
  botConfigId: z.number().int().positive(),
  configFingerprint: z.string().regex(/^[a-f0-9]{64}$/i),
  brainVersionId: z.number().int().positive(),
  brainVersion: z.string().min(1).max(120),
  executionAuthority: DemoAutopilotAuthoritySchema,
  marketType: z.enum(["spot", "futures", "forex"]),
  instruments: z.array(z.string().min(1).max(80)).min(1).max(200),
  strategyVersions: z.record(z.string().min(1).max(120), z.string().min(1).max(160)),
  maximumPositionSizeUsdt: z.number().finite().positive(),
  maximumLeverage: z.number().int().min(1).max(125),
  maximumPortfolioRiskPercent: z.number().finite().positive().max(100),
  maximumSymbolExposurePercent: z.number().finite().positive().max(1000),
  maximumNetExposurePercent: z.number().finite().positive().max(1000),
  maximumCorrelatedExposurePercent: z.number().finite().positive().max(1000),
  dailyLossLimitUsdt: z.number().finite().positive(),
  maximumDrawdownPercent: z.number().finite().positive().max(100),
  maximumConcurrentPositions: z.number().int().positive().max(1000),
  maximumMarketDataAgeSeconds: z.number().int().positive().max(300),
  allowedTradingHoursUtc: z.array(TradingWindowSchema).max(32),
  permittedPhase7Actions: z.array(Phase7MandateActionSchema).min(1).max(6),
  validFrom: z.string().datetime(),
  expiresAt: z.string().datetime(),
}).strict();

function validateMandate(
  value: z.infer<typeof DemoAutopilotMandateFieldsSchema>,
  ctx: z.RefinementCtx,
): void {
  if (Date.parse(value.expiresAt) <= Date.parse(value.validFrom)) {
    ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "must be after validFrom" });
  }
  if (Date.parse(value.expiresAt) - Date.parse(value.validFrom) > 90 * 24 * 60 * 60 * 1000) {
    ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "mandate duration may not exceed 90 days" });
  }
  if (Object.keys(value.strategyVersions).length === 0) {
    ctx.addIssue({ code: "custom", path: ["strategyVersions"], message: "at least one enabled strategy version is required" });
  }
  if (value.section === "forex" && value.marketType !== "forex") {
    ctx.addIssue({ code: "custom", path: ["marketType"], message: "forex section requires forex marketType" });
  }
  if (value.section === "crypto" && value.marketType === "forex") {
    ctx.addIssue({ code: "custom", path: ["marketType"], message: "crypto section cannot use forex marketType" });
  }
  if (value.executionAuthority === "binance_spot_testnet" && value.marketType !== "spot") {
    ctx.addIssue({ code: "custom", path: ["executionAuthority"], message: "Binance Spot testnet requires spot" });
  }
  if (value.executionAuthority === "binance_futures_demo" && value.marketType !== "futures") {
    ctx.addIssue({ code: "custom", path: ["executionAuthority"], message: "Binance Futures Demo requires futures" });
  }
  if (value.executionAuthority === "oanda_practice" && value.marketType !== "forex") {
    ctx.addIssue({ code: "custom", path: ["executionAuthority"], message: "OANDA practice requires forex" });
  }
  for (const required of ["HOLD", "FREEZE", "EXIT"] as const) {
    if (!value.permittedPhase7Actions.includes(required)) {
      ctx.addIssue({ code: "custom", path: ["permittedPhase7Actions"], message: `${required} is required so protective management remains available` });
    }
  }
}

export const DemoAutopilotMandateCoreSchema = DemoAutopilotMandateFieldsSchema.superRefine(validateMandate);

export const DemoAutopilotMandateSchema = DemoAutopilotMandateFieldsSchema.extend({
  id: z.number().int().positive(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/i),
  createdAt: z.string().datetime(),
}).strict().superRefine(validateMandate);

export type DemoAutopilotMandateCore = z.infer<typeof DemoAutopilotMandateCoreSchema>;
export type DemoAutopilotMandate = z.infer<typeof DemoAutopilotMandateSchema>;
export type DemoAutopilotAuthority = z.infer<typeof DemoAutopilotAuthoritySchema>;
export type AutopilotState = z.infer<typeof AutopilotStateSchema>;
export type BrainVersionState = z.infer<typeof BrainVersionStateSchema>;
export type Phase7MandateAction = z.infer<typeof Phase7MandateActionSchema>;

export function mandateFingerprint(core: DemoAutopilotMandateCore): string {
  return sha256Fingerprint(DemoAutopilotMandateCoreSchema.parse(core));
}

export interface AutopilotRuntimeEvidence {
  now: Date;
  state: AutopilotState;
  stateReason: string;
  globalSuspended: boolean;
  configSuspended: boolean;
  brainVersionState: BrainVersionState;
  mandateState: "INACTIVE" | "ACTIVE" | "SUSPENDED" | "REVOKED" | "EXPIRED";
  brainVersion: string;
  userId: number;
  section: "crypto" | "forex";
  botConfigId: number;
  configFingerprint: string;
  configuredMode: string;
  executionAuthority: ExecutionAuthority;
  marketType: "spot" | "futures" | "forex";
  providerConfigurationValid: boolean;
  reconciliationState: "HEALTHY" | "UNHEALTHY" | "UNKNOWN";
  marketState: {
    available: boolean;
    healthy: boolean;
    dataTimestamp: Date | null;
    fingerprint: string | null;
  };
  killSwitchActive: boolean;
  symbol: string;
  strategyId: string;
  strategyVersion: string;
  positionNotionalUsdt: number;
  leverage: number;
  portfolioRiskPercent: number | null;
  symbolExposurePercent: number | null;
  netExposurePercent: number | null;
  correlatedExposurePercent: number | null;
  dailyPnlUsdt: number | null;
  drawdownPercent: number | null;
  openPositionCount: number | null;
  deterministicRiskPassed: boolean;
  requiredEvidenceAvailable: boolean;
}

export interface AutopilotCheck {
  name: string;
  passed: boolean;
  reasonCode: string;
  detail: string;
}

export interface AutopilotEvaluation {
  allowed: boolean;
  reasonCode: string;
  reason: string;
  checks: AutopilotCheck[];
}

function isWithinTradingWindow(now: Date, windows: DemoAutopilotMandateCore["allowedTradingHoursUtc"]): boolean {
  if (windows.length === 0) return true;
  const day = now.getUTCDay();
  const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
  return windows.some((window) =>
    window.daysOfWeekUtc.includes(day) && minute >= window.startMinuteUtc && minute < window.endMinuteUtc,
  );
}

function finiteWithin(actual: number | null, maximum: number): boolean {
  return actual !== null && Number.isFinite(actual) && actual <= maximum;
}

export function evaluateAutopilotEntry(
  mandateInput: DemoAutopilotMandateCore | null,
  evidence: AutopilotRuntimeEvidence,
): AutopilotEvaluation {
  if (!mandateInput) {
    const check = { name: "Mandate", passed: false, reasonCode: "MANDATE_MISSING", detail: "No immutable Demo Autopilot mandate is available" };
    return { allowed: false, reasonCode: check.reasonCode, reason: check.detail, checks: [check] };
  }
  const mandate = DemoAutopilotMandateCoreSchema.parse(mandateInput);
  const marketAgeMs = evidence.marketState.dataTimestamp
    ? evidence.now.getTime() - evidence.marketState.dataTimestamp.getTime()
    : Number.POSITIVE_INFINITY;
  const checks: AutopilotCheck[] = [
    { name: "Autopilot state", passed: evidence.state === "AUTOPILOT_ENABLED", reasonCode: "AUTOPILOT_NOT_ENABLED", detail: evidence.state === "AUTOPILOT_ENABLED" ? "Autopilot is enabled" : evidence.stateReason },
    { name: "Global suspension", passed: !evidence.globalSuspended, reasonCode: "GLOBAL_SUSPENSION_ACTIVE", detail: evidence.globalSuspended ? "Global Demo Autopilot suspension is active" : "No global suspension" },
    { name: "Configuration suspension", passed: !evidence.configSuspended, reasonCode: "CONFIG_SUSPENSION_ACTIVE", detail: evidence.configSuspended ? "This configuration is suspended" : "Configuration is not suspended" },
    { name: "Mode", passed: evidence.configuredMode === "autopilot", reasonCode: "MODE_NOT_AUTOPILOT", detail: evidence.configuredMode === "autopilot" ? "Configuration requests Autopilot" : `Configured mode is ${evidence.configuredMode}` },
    { name: "Brain version state", passed: evidence.brainVersionState === "DEMO_APPROVED", reasonCode: "BRAIN_VERSION_NOT_DEMO_APPROVED", detail: `Brain version state is ${evidence.brainVersionState}` },
    { name: "Mandate lifecycle", passed: evidence.mandateState === "ACTIVE", reasonCode: evidence.mandateState === "REVOKED" ? "MANDATE_REVOKED" : evidence.mandateState === "EXPIRED" ? "MANDATE_EXPIRED" : "MANDATE_NOT_ACTIVE", detail: `Mandate state is ${evidence.mandateState}` },
    { name: "Brain version binding", passed: evidence.brainVersion === mandate.brainVersion, reasonCode: "BRAIN_VERSION_MISMATCH", detail: `Expected ${mandate.brainVersion}; received ${evidence.brainVersion}` },
    { name: "Mandate start", passed: evidence.now.getTime() >= Date.parse(mandate.validFrom), reasonCode: "MANDATE_NOT_YET_VALID", detail: `Mandate starts ${mandate.validFrom}` },
    { name: "Mandate expiry", passed: evidence.now.getTime() < Date.parse(mandate.expiresAt), reasonCode: "MANDATE_EXPIRED", detail: `Mandate expires ${mandate.expiresAt}` },
    { name: "Account", passed: evidence.userId === mandate.userId && evidence.section === mandate.section, reasonCode: "ACCOUNT_NOT_ELIGIBLE", detail: `Mandate is pinned to user ${mandate.userId}/${mandate.section}` },
    { name: "Configuration", passed: evidence.botConfigId === mandate.botConfigId && evidence.configFingerprint === mandate.configFingerprint, reasonCode: "CONFIGURATION_CHANGED", detail: evidence.configFingerprint === mandate.configFingerprint ? "Configuration fingerprint matches" : "Configuration changed after mandate approval" },
    { name: "Execution authority", passed: evidence.executionAuthority === mandate.executionAuthority && DemoAutopilotAuthoritySchema.safeParse(evidence.executionAuthority).success, reasonCode: "AUTHORITY_NOT_APPROVED_DEMO", detail: `Resolved authority is ${evidence.executionAuthority}` },
    { name: "Market type", passed: evidence.marketType === mandate.marketType, reasonCode: "MARKET_TYPE_NOT_ELIGIBLE", detail: `Resolved market is ${evidence.marketType}` },
    { name: "Provider configuration", passed: evidence.providerConfigurationValid, reasonCode: "PROVIDER_CONFIGURATION_INVALID", detail: evidence.providerConfigurationValid ? "Provider/configuration is valid" : "Provider/configuration is unavailable or invalid" },
    { name: "Reconciliation", passed: evidence.reconciliationState === "HEALTHY", reasonCode: evidence.reconciliationState === "UNKNOWN" ? "RECONCILIATION_UNKNOWN" : "RECONCILIATION_UNHEALTHY", detail: `Reconciliation is ${evidence.reconciliationState}` },
    { name: "Market data available", passed: evidence.marketState.available && evidence.marketState.healthy, reasonCode: "MARKET_DATA_UNAVAILABLE", detail: evidence.marketState.available && evidence.marketState.healthy ? "MarketState is available and healthy" : "MarketState is missing or unhealthy" },
    { name: "Market data freshness", passed: marketAgeMs >= 0 && marketAgeMs <= mandate.maximumMarketDataAgeSeconds * 1000, reasonCode: "MARKET_DATA_STALE", detail: Number.isFinite(marketAgeMs) ? `MarketState age is ${Math.round(marketAgeMs)}ms` : "MarketState timestamp is unavailable" },
    { name: "Kill switches", passed: !evidence.killSwitchActive, reasonCode: "KILL_SWITCH_ACTIVE", detail: evidence.killSwitchActive ? "A deterministic entry kill switch is active" : "No entry kill switch is active" },
    { name: "Instrument", passed: mandate.instruments.includes(evidence.symbol), reasonCode: "INSTRUMENT_NOT_ELIGIBLE", detail: `${evidence.symbol} ${mandate.instruments.includes(evidence.symbol) ? "is" : "is not"} eligible` },
    { name: "Strategy version", passed: mandate.strategyVersions[evidence.strategyId] === evidence.strategyVersion, reasonCode: "STRATEGY_VERSION_NOT_ELIGIBLE", detail: `Strategy ${evidence.strategyId} version is ${evidence.strategyVersion}` },
    { name: "Position size", passed: Number.isFinite(evidence.positionNotionalUsdt) && evidence.positionNotionalUsdt <= mandate.maximumPositionSizeUsdt, reasonCode: "POSITION_SIZE_LIMIT_EXCEEDED", detail: `$${evidence.positionNotionalUsdt.toFixed(2)} / $${mandate.maximumPositionSizeUsdt.toFixed(2)} maximum` },
    { name: "Leverage", passed: Number.isFinite(evidence.leverage) && evidence.leverage >= 1 && evidence.leverage <= mandate.maximumLeverage, reasonCode: "LEVERAGE_LIMIT_EXCEEDED", detail: `${evidence.leverage}x / ${mandate.maximumLeverage}x maximum` },
    { name: "Portfolio risk", passed: finiteWithin(evidence.portfolioRiskPercent, mandate.maximumPortfolioRiskPercent), reasonCode: "PORTFOLIO_RISK_LIMIT_EXCEEDED", detail: `${evidence.portfolioRiskPercent ?? "unknown"}% / ${mandate.maximumPortfolioRiskPercent}% maximum` },
    { name: "Symbol exposure", passed: finiteWithin(evidence.symbolExposurePercent, mandate.maximumSymbolExposurePercent), reasonCode: "SYMBOL_EXPOSURE_LIMIT_EXCEEDED", detail: `${evidence.symbolExposurePercent ?? "unknown"}% / ${mandate.maximumSymbolExposurePercent}% maximum` },
    { name: "Net exposure", passed: finiteWithin(Math.abs(evidence.netExposurePercent ?? Number.NaN), mandate.maximumNetExposurePercent), reasonCode: "NET_EXPOSURE_LIMIT_EXCEEDED", detail: `${evidence.netExposurePercent ?? "unknown"}% / ${mandate.maximumNetExposurePercent}% maximum` },
    { name: "Correlated exposure", passed: finiteWithin(evidence.correlatedExposurePercent, mandate.maximumCorrelatedExposurePercent), reasonCode: "CORRELATED_EXPOSURE_LIMIT_EXCEEDED", detail: `${evidence.correlatedExposurePercent ?? "unknown"}% / ${mandate.maximumCorrelatedExposurePercent}% maximum` },
    { name: "Daily loss", passed: evidence.dailyPnlUsdt !== null && Number.isFinite(evidence.dailyPnlUsdt) && evidence.dailyPnlUsdt > -mandate.dailyLossLimitUsdt, reasonCode: "DAILY_LOSS_LIMIT_EXCEEDED", detail: `${evidence.dailyPnlUsdt ?? "unknown"} USDT / -${mandate.dailyLossLimitUsdt} USDT limit` },
    { name: "Drawdown", passed: finiteWithin(evidence.drawdownPercent, mandate.maximumDrawdownPercent), reasonCode: "DRAWDOWN_LIMIT_EXCEEDED", detail: `${evidence.drawdownPercent ?? "unknown"}% / ${mandate.maximumDrawdownPercent}% maximum` },
    { name: "Concurrent positions", passed: evidence.openPositionCount !== null && Number.isInteger(evidence.openPositionCount) && evidence.openPositionCount < mandate.maximumConcurrentPositions, reasonCode: "CONCURRENT_POSITION_LIMIT_EXCEEDED", detail: `${evidence.openPositionCount ?? "unknown"} / ${mandate.maximumConcurrentPositions} maximum` },
    { name: "Trading hours", passed: isWithinTradingWindow(evidence.now, mandate.allowedTradingHoursUtc), reasonCode: "OUTSIDE_ALLOWED_TRADING_HOURS", detail: mandate.allowedTradingHoursUtc.length === 0 ? "No additional mandate hours restriction" : "Evaluated against UTC mandate windows" },
    { name: "Deterministic risk", passed: evidence.deterministicRiskPassed, reasonCode: "DETERMINISTIC_RISK_REFUSED", detail: evidence.deterministicRiskPassed ? "Existing deterministic risk checks passed" : "Existing deterministic risk checks refused entry" },
    { name: "Required evidence", passed: evidence.requiredEvidenceAvailable, reasonCode: "REQUIRED_EVIDENCE_UNAVAILABLE", detail: evidence.requiredEvidenceAvailable ? "Required decision, market, risk, and portfolio evidence is available" : "Required evidence is unavailable" },
  ];
  const failed = checks.find((check) => !check.passed);
  return failed
    ? { allowed: false, reasonCode: failed.reasonCode, reason: failed.detail, checks }
    : { allowed: true, reasonCode: "AUTOPILOT_ENTRY_AUTHORIZED", reason: "Exact Demo mandate and every deterministic safety check passed", checks };
}

export function isAutonomousLiveAuthority(authority: ExecutionAuthority): boolean {
  return authority === "binance_spot_live" || authority === "binance_futures_live" || authority === "oanda_live";
}

/** A position keeps the exact Phase 7 action scope frozen at autonomous entry. */
export function autopilotMandatePermitsManagementAction(
  mandateId: number | null | undefined,
  persistedActions: unknown,
  action: string,
): boolean {
  if (mandateId == null) return true;
  return Array.isArray(persistedActions)
    && persistedActions.every((item) => typeof item === "string")
    && persistedActions.includes(action);
}
