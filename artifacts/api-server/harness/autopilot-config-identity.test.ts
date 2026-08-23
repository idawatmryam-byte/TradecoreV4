/**
 * Regression coverage for BUG-003 (Phase 11 validation finding).
 *
 * runScan() used to pass the HIGH-FREQUENCY-OVERRIDDEN config copy into
 * authorizeAutopilotEntry(). The immutable mandate freezes its configuration
 * fingerprint from the PERSISTED row, so while highFrequencyTestMode was on
 * the two fingerprints could never match: every autonomous decision was
 * refused with CONFIGURATION_CHANGED ("Configuration changed after mandate
 * approval") even though nothing had changed, and Demo Autopilot suspended
 * itself. Observed live: mandate created 15:16:00Z, refusal 15:21:00Z with
 * bot_config.updated_at unchanged (15:13:55Z).
 *
 * Contract pinned here:
 *  1. HF runtime overrides DO change the config fingerprint (they must never
 *     be silently folded into an authorization identity);
 *  2. evaluateAutopilotEntry accepts a decision whose configFingerprint
 *     equals the mandate's (persisted identity), and refuses with
 *     CONFIGURATION_CHANGED when it differs — which is exactly why the
 *     engine must pass the persisted row, not the runtime-effective copy.
 */
let failures = 0;
function expect(name: string, condition: boolean, detail = ""): void {
  if (condition) console.log(`  PASS  ${name}`);
  else {
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    failures += 1;
  }
}

import { autopilotConfigFingerprint } from "../src/lib/autopilot/fingerprints";
import { evaluateAutopilotEntry, DEMO_AUTOPILOT_SCHEMA_VERSION } from "../src/lib/autopilot/contracts";

const rawConfig = {
  id: 3,
  userId: 8,
  section: "crypto",
  broker: "binance",
  marketType: "futures",
  executionTarget: "demo",
  testnet: true,
  mode: "autopilot",
  positionManagementMode: "fixed",
  positionSizeUsdt: "2000",
  riskPercent: "0.75",
  maxOpenPositions: 3,
  maxPortfolioRiskPercent: "6",
  dailyLossLimitUsdt: "150",
  maxSymbolConcentrationPercent: "100",
  maxNetExposurePercent: "200",
  maxCorrelatedExposurePercent: "200",
  correlationThreshold: "0.7",
  correlationUnknownPolicy: "allow",
  confidenceThreshold: 50,
  riskModel: "percent",
  stopLossPercent: "1.5",
  takeProfitPercent: "2.5",
  maxLossUsdt: "5",
  targetProfitUsdt: "10",
  cooldownMinutes: 30,
  scanIntervalSeconds: 60,
  pairs: "BTCUSDT,ETHUSDT,SOLUSDT",
  demoStartingBalanceUsdt: "10000",
  backtestMode: false,
  highFrequencyTestMode: true,
  leverage: 5,
  marginMode: "isolated",
} as const;

// Mirror of botEngine.applyHighFreqOverrides for the fields it rewrites.
const hfOverriddenConfig = {
  ...rawConfig,
  cooldownMinutes: 0,
  confidenceThreshold: 0,
  maxOpenPositions: 30,
  dailyLossLimitUsdt: "1000000000",
};

function mandateFor(configFingerprint: string) {
  return {
    schemaVersion: DEMO_AUTOPILOT_SCHEMA_VERSION,
    userId: 8,
    section: "crypto",
    version: 1,
    botConfigId: rawConfig.id,
    configFingerprint,
    brainVersionId: 1,
    brainVersion: "brain-v0",
    executionAuthority: "simulated_demo" as const,
    marketType: "futures" as const,
    instruments: ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
    strategyVersions: { trend_pullback: "strategy-config:fixture" },
    maximumPositionSizeUsdt: 2000,
    maximumLeverage: 5,
    maximumPortfolioRiskPercent: 6,
    maximumSymbolExposurePercent: 100,
    maximumNetExposurePercent: 200,
    maximumCorrelatedExposurePercent: 200,
    dailyLossLimitUsdt: 150,
    maximumDrawdownPercent: 10,
    maximumConcurrentPositions: 3,
    maximumMarketDataAgeSeconds: 120,
    allowedTradingHoursUtc: [],
    permittedPhase7Actions: ["HOLD", "FREEZE", "REDUCE", "TIGHTEN_STOP", "EXIT"] as const,
    validFrom: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
}

const baseEvaluation = {
  now: new Date(),
  state: "AUTOPILOT_ENABLED" as const,
  stateReason: null,
  globalSuspended: false,
  configSuspended: false,
  brainVersionState: "DEMO_APPROVED" as const,
  mandateState: "ACTIVE" as const,
  brainVersion: "brain-v0",
  userId: 8,
  section: "crypto" as const,
  botConfigId: rawConfig.id,
  configuredMode: "autopilot",
  marketType: "futures" as const,
  executionAuthority: "simulated_demo" as const,
  providerConfigurationValid: true,
  reconciliationState: "HEALTHY",
  marketState: {
    available: true,
    healthy: true,
    dataTimestamp: new Date(),
    fingerprint: "a".repeat(64),
    ageSeconds: 5,
    marketStateVersion: "fixture",
  },
  killSwitchActive: false,
  symbol: "SOLUSDT",
  strategyId: "trend_pullback",
  strategyVersion: "strategy-config:fixture",
  positionNotionalUsdt: 950,
  leverage: 5,
  portfolioRiskPercent: 1,
  symbolExposurePercent: 5,
  netExposurePercent: 5,
  correlatedExposurePercent: 5,
  dailyPnlUsdt: 0,
  drawdownPercent: 0,
  openPositionCount: 0,
  deterministicRiskPassed: true,
  requiredEvidenceAvailable: true,
  balanceUsdt: 10000,
  dailyPnlUsdt: 0,
  openPositionCount: 0,
  portfolioRiskPercent: 1,
  symbolExposurePercent: 5,
  netExposurePercent: 5,
  correlatedExposurePercent: 5,
};

const persistedFingerprint = autopilotConfigFingerprint(rawConfig);
const overriddenFingerprint = autopilotConfigFingerprint(hfOverriddenConfig);

expect(
  "HF runtime overrides change the config fingerprint (identity must use the persisted row)",
  persistedFingerprint !== overriddenFingerprint,
);

const matched = evaluateAutopilotEntry(mandateFor(persistedFingerprint), {
  ...baseEvaluation,
  configFingerprint: persistedFingerprint,
});
expect(
  "decision authorized when configFingerprint equals the mandate's persisted fingerprint",
  matched.allowed === true,
  matched.allowed ? "" : `refused: ${matched.reasonCode}`,
);

const diverged = evaluateAutopilotEntry(mandateFor(persistedFingerprint), {
  ...baseEvaluation,
  configFingerprint: overriddenFingerprint,
});
expect(
  "decision refused with CONFIGURATION_CHANGED when fingerprints diverge",
  diverged.allowed === false && diverged.reasonCode === "CONFIGURATION_CHANGED",
  diverged.allowed ? "unexpectedly allowed" : diverged.reasonCode,
);

// BUG-004 companion: strategy identity must hash the PERSISTED strategy
// config, not the high-frequency-effective copy.
import { strategyConfigVersion } from "../src/lib/autopilot/fingerprints";
const rawStrategyConfig = {
  strategyId: "trend_pullback", enabled: true, tradeAmountUsdt: 5000,
  maxLossUsdt: 10, targetProfitUsdt: 12, riskPercent: 1.2, confidenceThreshold: 65,
  stopLossPercent: 1.5, takeProfitPercent: 2.5, maxHoldingSeconds: 28800,
  maxConcurrentPositions: 3, cooldownMinutes: 20, breakEvenRMultiple: 0,
  tp1RMultiple: 1, tp1ClosePercent: 40, tp3Enabled: true, tp2RMultiple: 2,
  tp2ClosePercent: 30, tp3RMultiple: 5, trailingStopMode: "dynamic",
  trailingStopAtrMultiplier: 2, trailingStopPercent: 1.5, trailingAfterTp1Only: true,
  emergencyTrailingRMultiple: 4, emergencyTrailingPercent: 0.75,
  exitPriority: ["stop_loss", "take_profit", "trailing_stop", "timeout"],
};
const hfEffectiveStrategyConfig = {
  ...rawStrategyConfig,
  maxHoldingSeconds: 600, cooldownMinutes: 0, maxConcurrentPositions: 10,
};
expect(
  "HF strategy overrides change strategyConfigVersion (identity must use persisted rows)",
  strategyConfigVersion("trend_pullback", rawStrategyConfig) !== strategyConfigVersion("trend_pullback", hfEffectiveStrategyConfig),
);
expect(
  "strategyConfigVersion is stable for the persisted config",
  strategyConfigVersion("trend_pullback", rawStrategyConfig) === strategyConfigVersion("trend_pullback", { ...rawStrategyConfig }),
);

if (failures > 0) {
  console.error(`autopilot-config-identity: ${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("autopilot-config-identity: all checks passed");
