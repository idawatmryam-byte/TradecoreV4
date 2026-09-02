import {
  DemoAutopilotAuthoritySchema,
  autopilotMandatePermitsManagementAction,
  evaluateAutopilotEntry,
  type AutopilotRuntimeEvidence,
  type DemoAutopilotMandateCore,
} from "../src/lib/autopilot/contracts";
import {
  autopilotConfigFingerprint,
  autonomousIdempotencyKey,
} from "../src/lib/autopilot/fingerprints";
import {
  makeAutopilotClientOrderId,
  makeAutopilotCorrelationId,
} from "../src/lib/execution/ids";
import { resolveExecutionAuthority } from "../src/lib/execution/authority";
import {
  DemoExecutionIsolationError,
  restrictToDemoMarketData,
} from "../src/lib/execution/demoMarketData";
import {
  autopilotDeploymentHardStop,
  globalAutopilotSuspended,
  requiresAutopilotControlPlane,
} from "../src/lib/autopilot/config";

let failures = 0;
function expect(name: string, condition: boolean, detail = "") {
  if (!condition) failures++;
  console.log(
    `${condition ? "✓" : "✗ FAIL"}  ${name}${condition ? "" : `  ${detail}`}`,
  );
}

const now = new Date("2026-08-12T12:00:00.000Z");

expect(
  "production defaults global Autopilot suspension fail-closed",
  globalAutopilotSuspended({ NODE_ENV: "production" }),
);
expect(
  "invalid global suspension configuration fails closed",
  globalAutopilotSuspended({
    NODE_ENV: "production",
    AUTOPILOT_GLOBAL_SUSPENDED: "invalid",
  }),
);
expect(
  "explicit reviewed false can lift only the global deployment suspension",
  !globalAutopilotSuspended({
    NODE_ENV: "production",
    AUTOPILOT_GLOBAL_SUSPENDED: "false",
  }),
);
expect(
  "development remains opt-in compatible when suspension is absent",
  !globalAutopilotSuspended({ NODE_ENV: "development" }),
);
expect(
  "internal Demo AutoPilot needs no separate control plane",
  !requiresAutopilotControlPlane({ mode: "autopilot", executionTarget: "demo" }),
);
expect(
  "broker-backed AutoPilot retains its control plane",
  requiresAutopilotControlPlane({ mode: "autopilot", executionTarget: "live" }),
);
expect(
  "Co-Pilot never enters the AutoPilot control plane",
  !requiresAutopilotControlPlane({ mode: "copilot", executionTarget: "demo" }),
);
expect(
  "an absent deployment override delegates to persisted fail-closed control",
  !autopilotDeploymentHardStop({ NODE_ENV: "production" }).active,
);
expect(
  "an explicit deployment hard stop cannot be cleared by Admin state",
  autopilotDeploymentHardStop({
    NODE_ENV: "production",
    AUTOPILOT_GLOBAL_SUSPENDED: "true",
  }).active,
);
expect(
  "a malformed deployment hard stop fails closed",
  autopilotDeploymentHardStop({
    NODE_ENV: "production",
    AUTOPILOT_GLOBAL_SUSPENDED: "invalid",
  }).active,
);

const mandate: DemoAutopilotMandateCore = {
  schemaVersion: "phase10-demo-autopilot-v1",
  userId: 10,
  section: "crypto",
  version: 1,
  botConfigId: 20,
  configFingerprint: "a".repeat(64),
  brainVersionId: 30,
  brainVersion: "brain-v0",
  executionAuthority: "simulated_demo",
  marketType: "spot",
  instruments: ["BTCUSDT"],
  strategyVersions: { breakout: "strategy-config:fixture" },
  maximumPositionSizeUsdt: 500,
  maximumLeverage: 1,
  maximumPortfolioRiskPercent: 5,
  maximumSymbolExposurePercent: 50,
  maximumNetExposurePercent: 100,
  maximumCorrelatedExposurePercent: 100,
  dailyLossLimitUsdt: 100,
  maximumDrawdownPercent: 10,
  maximumConcurrentPositions: 3,
  maximumMarketDataAgeSeconds: 30,
  allowedTradingHoursUtc: [],
  permittedPhase7Actions: [
    "HOLD",
    "FREEZE",
    "REDUCE",
    "TIGHTEN_STOP",
    "APPLY_TRAILING",
    "EXIT",
  ],
  validFrom: "2026-08-12T00:00:00.000Z",
  expiresAt: "2026-08-13T00:00:00.000Z",
};

const evidence: AutopilotRuntimeEvidence = {
  now,
  state: "AUTOPILOT_ENABLED",
  stateReason: "Human-approved Demo mandate",
  globalSuspended: false,
  configSuspended: false,
  brainVersionState: "DEMO_APPROVED",
  mandateState: "ACTIVE",
  brainVersion: "brain-v0",
  userId: 10,
  section: "crypto",
  botConfigId: 20,
  configFingerprint: "a".repeat(64),
  configuredMode: "autopilot",
  executionAuthority: "simulated_demo",
  marketType: "spot",
  providerConfigurationValid: true,
  reconciliationState: "HEALTHY",
  marketState: {
    available: true,
    healthy: true,
    dataTimestamp: new Date(now.getTime() - 1_000),
    fingerprint: "b".repeat(64),
  },
  killSwitchActive: false,
  symbol: "BTCUSDT",
  strategyId: "breakout",
  strategyVersion: "strategy-config:fixture",
  positionNotionalUsdt: 250,
  leverage: 1,
  portfolioRiskPercent: 2,
  symbolExposurePercent: 25,
  netExposurePercent: 25,
  correlatedExposurePercent: 25,
  dailyPnlUsdt: 0,
  drawdownPercent: 0,
  openPositionCount: 1,
  deterministicRiskPassed: true,
  requiredEvidenceAvailable: true,
};

function evaluate(
  overrides: Partial<AutopilotRuntimeEvidence> = {},
  mandateOverrides: Partial<DemoAutopilotMandateCore> = {},
) {
  return evaluateAutopilotEntry(
    { ...mandate, ...mandateOverrides },
    { ...evidence, ...overrides },
  );
}

expect(
  "valid autonomous simulated Demo decision is authorized",
  evaluate().allowed,
);
expect(
  "persisted immutable mandate is authorized by the same strict evaluator",
  evaluateAutopilotEntry(
    {
      ...mandate,
      id: 1,
      fingerprint: "c".repeat(64),
      createdAt: "2026-08-11T23:59:00.000Z",
    },
    evidence,
  ).allowed,
);
expect(
  "missing mandate fails closed",
  evaluateAutopilotEntry(null, evidence).reasonCode === "MANDATE_MISSING",
);
expect(
  "expired mandate fails closed",
  evaluate({}, { expiresAt: now.toISOString() }).reasonCode ===
    "MANDATE_EXPIRED",
);
expect(
  "real Live authority is categorically refused",
  evaluate({ executionAuthority: "binance_spot_live" }).reasonCode ===
    "AUTHORITY_NOT_APPROVED_DEMO",
);
expect(
  "ambiguous authority is refused",
  evaluate({ executionAuthority: "legacy_unverified" }).reasonCode ===
    "AUTHORITY_NOT_APPROVED_DEMO",
);
expect(
  "invalid provider configuration is refused",
  evaluate({ providerConfigurationValid: false }).reasonCode ===
    "PROVIDER_CONFIGURATION_INVALID",
);
expect(
  "reconciliation UNKNOWN is refused",
  evaluate({ reconciliationState: "UNKNOWN" }).reasonCode ===
    "RECONCILIATION_UNKNOWN",
);
expect(
  "stale market data is refused",
  evaluate({
    marketState: {
      ...evidence.marketState,
      dataTimestamp: new Date(now.getTime() - 31_000),
    },
  }).reasonCode === "MARKET_DATA_STALE",
);
expect(
  "portfolio risk limit breach is refused",
  evaluate({ portfolioRiskPercent: 6 }).reasonCode ===
    "PORTFOLIO_RISK_LIMIT_EXCEEDED",
);
expect(
  "daily loss limit breach is refused",
  evaluate({ dailyPnlUsdt: -100 }).reasonCode === "DAILY_LOSS_LIMIT_EXCEEDED",
);
expect(
  "drawdown limit breach is refused",
  evaluate({ drawdownPercent: 11 }).reasonCode === "DRAWDOWN_LIMIT_EXCEEDED",
);
expect(
  "concurrent position limit breach is refused",
  evaluate({ openPositionCount: 3 }).reasonCode ===
    "CONCURRENT_POSITION_LIMIT_EXCEEDED",
);
expect(
  "kill switch stops autonomous entries",
  evaluate({ killSwitchActive: true }).reasonCode === "KILL_SWITCH_ACTIVE",
);
expect(
  "global suspension stops autonomous entries",
  evaluate({ globalSuspended: true }).reasonCode === "GLOBAL_SUSPENSION_ACTIVE",
);
expect(
  "paused entries fail closed",
  evaluate({ state: "AUTOPILOT_PAUSED", stateReason: "operator pause" })
    .reasonCode === "AUTOPILOT_NOT_ENABLED",
);
expect(
  "missing unified-brain evidence is refused",
  evaluate({ requiredEvidenceAvailable: false }).reasonCode ===
    "REQUIRED_EVIDENCE_UNAVAILABLE",
);
expect(
  "protective HOLD remains mandated",
  mandate.permittedPhase7Actions.includes("HOLD"),
);
expect(
  "protective FREEZE remains mandated",
  mandate.permittedPhase7Actions.includes("FREEZE"),
);
expect(
  "protective EXIT remains mandated",
  mandate.permittedPhase7Actions.includes("EXIT"),
);
expect(
  "autonomous position permits its pinned protective EXIT after entry",
  autopilotMandatePermitsManagementAction(
    1,
    mandate.permittedPhase7Actions,
    "EXIT",
  ),
);
expect(
  "autonomous position refuses a management action outside its pinned mandate",
  !autopilotMandatePermitsManagementAction(
    1,
    ["HOLD", "FREEZE", "EXIT"],
    "APPLY_TRAILING",
  ),
);

const routes = [
  [
    {
      section: "crypto",
      marketType: "spot",
      executionTarget: "demo",
      testnet: false,
    },
    "simulated_demo",
  ],
  [
    {
      section: "crypto",
      marketType: "spot",
      executionTarget: "live",
      testnet: true,
    },
    "binance_spot_testnet",
  ],
  [
    {
      section: "crypto",
      marketType: "futures",
      executionTarget: "live",
      testnet: true,
    },
    "binance_futures_demo",
  ],
  [
    {
      section: "forex",
      marketType: "forex",
      executionTarget: "live",
      testnet: true,
    },
    "oanda_practice",
  ],
] as const;
for (const [route, expected] of routes) {
  const authority = resolveExecutionAuthority(route);
  expect(
    `${expected} routes to its exact sandbox authority`,
    authority === expected &&
      DemoAutopilotAuthoritySchema.safeParse(authority).success,
  );
}

const key = autonomousIdempotencyKey({
  userId: 10,
  section: "crypto",
  mandateFingerprint: "c".repeat(64),
  decisionFingerprint: "d".repeat(64),
});
expect(
  "autonomous idempotency key is deterministic",
  key ===
    autonomousIdempotencyKey({
      userId: 10,
      section: "crypto",
      mandateFingerprint: "c".repeat(64),
      decisionFingerprint: "d".repeat(64),
    }),
);
expect(
  "provider client order id is deterministic",
  makeAutopilotClientOrderId(10, key) === makeAutopilotClientOrderId(10, key),
);
expect(
  "correlation id is deterministic",
  makeAutopilotCorrelationId(key) === makeAutopilotCorrelationId(key),
);
const configIdentity = {
  id: 20,
  userId: 10,
  section: "crypto",
  broker: "binance",
  marketType: "spot",
  executionTarget: "demo",
  testnet: false,
  mode: "autopilot",
  positionManagementMode: "phase7_active",
  positionSizeUsdt: "250",
  riskPercent: "1",
  maxOpenPositions: 3,
  maxPortfolioRiskPercent: "5",
  dailyLossLimitUsdt: "100",
  maxSymbolConcentrationPercent: "50",
  maxNetExposurePercent: "100",
  maxCorrelatedExposurePercent: "100",
  correlationThreshold: "0.7",
  correlationUnknownPolicy: "block",
  confidenceThreshold: 65,
  riskModel: "percent",
  stopLossPercent: "2",
  takeProfitPercent: "4",
  maxLossUsdt: "10",
  targetProfitUsdt: "20",
  cooldownMinutes: 15,
  scanIntervalSeconds: 30,
  demoStartingBalanceUsdt: "10000",
  backtestMode: false,
  highFrequencyTestMode: false,
  leverage: 1,
  marginMode: "isolated",
  pairs: "BTCUSDT",
};
expect(
  "exact config fingerprint is deterministic",
  autopilotConfigFingerprint(configIdentity) ===
    autopilotConfigFingerprint({ ...configIdentity }),
);
expect(
  "high-frequency override invalidates the mandate config fingerprint",
  autopilotConfigFingerprint(configIdentity) !==
    autopilotConfigFingerprint({
      ...configIdentity,
      highFrequencyTestMode: true,
    }),
);

let externalOrderCalls = 0;
const marketOnly = restrictToDemoMarketData({
  markets: {},
  async loadMarkets() {
    return {};
  },
  async fetchTicker() {
    return { last: 100 };
  },
  async createOrder() {
    externalOrderCalls++;
    return {};
  },
});
let isolated = false;
try {
  await marketOnly.createOrder();
} catch (error) {
  isolated = error instanceof DemoExecutionIsolationError;
}
expect(
  "simulated Demo capability cannot reach an external broker",
  isolated && externalOrderCalls === 0,
);

console.log(
  failures === 0
    ? "\ndemo-autopilot: all checks passed"
    : `\ndemo-autopilot: ${failures} FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
