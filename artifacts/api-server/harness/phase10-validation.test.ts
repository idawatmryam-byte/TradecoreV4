import type { BotConfig } from "@workspace/db";
import type { ExecutionAuthority } from "../src/lib/execution/authority";
import type { DemoAutopilotMandate } from "../src/lib/autopilot/contracts";
import { DemoAutopilotMandateSchema } from "../src/lib/autopilot/contracts";
import {
  assertSimulatedDemoValidationBoundary,
  authorizePhase10Validation,
  buildPhase10ValidationCandles,
  PHASE10_VALIDATION_CONFIRMATION,
} from "../src/lib/autopilot/validation";

const RUN_ID = "00000000-0000-4000-8000-000000000010";
const TOKEN = "phase10-pure-validation-token-000000000000000000";
let failures = 0;

function expect(name: string, condition: boolean, detail = "") {
  if (!condition) failures++;
  console.log(
    `${condition ? "✓" : "✗ FAIL"}  ${name}${condition ? "" : `  ${detail}`}`,
  );
}

function refused(action: () => unknown): boolean {
  try {
    action();
    return false;
  } catch {
    return true;
  }
}

const baseEnvironment = {
  PHASE10_VALIDATION_ENABLED: "true",
  PHASE10_VALIDATION_TOKEN: TOKEN,
  AUTOPILOT_GLOBAL_SUSPENDED: "false",
};

expect(
  "validation is unavailable unless explicitly armed",
  refused(() =>
    authorizePhase10Validation({
      runId: RUN_ID,
      operatorUserId: 1,
      confirmation: PHASE10_VALIDATION_CONFIRMATION,
      token: TOKEN,
      environment: { ...baseEnvironment, PHASE10_VALIDATION_ENABLED: "false" },
    }),
  ),
);
expect(
  "validation refuses an incorrect operator token",
  refused(() =>
    authorizePhase10Validation({
      runId: RUN_ID,
      operatorUserId: 1,
      confirmation: PHASE10_VALIDATION_CONFIRMATION,
      token: "wrong-phase10-token-value-000000000000000000000",
      environment: baseEnvironment,
    }),
  ),
);
expect(
  "entry lifecycle refuses while global suspension is active",
  refused(() =>
    authorizePhase10Validation({
      runId: RUN_ID,
      operatorUserId: 1,
      confirmation: PHASE10_VALIDATION_CONFIRMATION,
      token: TOKEN,
      environment: { ...baseEnvironment, AUTOPILOT_GLOBAL_SUSPENDED: "true" },
    }),
  ),
);
expect(
  "final confirmation refuses until global suspension is restored",
  refused(() =>
    authorizePhase10Validation({
      runId: RUN_ID,
      operatorUserId: 1,
      confirmation: PHASE10_VALIDATION_CONFIRMATION,
      token: TOKEN,
      requiresGlobalSuspension: "active",
      environment: baseEnvironment,
    }),
  ),
);

const authorization = authorizePhase10Validation({
  runId: RUN_ID,
  operatorUserId: 1,
  confirmation: PHASE10_VALIDATION_CONFIRMATION,
  token: TOKEN,
  environment: baseEnvironment,
});
expect(
  "explicit dual-gate authorization issues a run-bound capability",
  authorization.runId === RUN_ID && authorization.operatorUserId === 1,
);

const config = {
  executionTarget: "demo",
  mode: "autopilot",
  positionManagementMode: "phase7_active",
  marketType: "spot",
} as BotConfig;
const mandate = {
  id: 1,
  schemaVersion: "phase10-demo-autopilot-v1",
  userId: 1,
  section: "crypto",
  version: 1,
  botConfigId: 1,
  configFingerprint: "a".repeat(64),
  brainVersionId: 1,
  brainVersion: "brain-v0",
  executionAuthority: "simulated_demo",
  marketType: "spot",
  instruments: ["BTCUSDT"],
  strategyVersions: { trend_pullback: "strategy-v1" },
  maximumPositionSizeUsdt: 100,
  maximumLeverage: 1,
  maximumPortfolioRiskPercent: 5,
  maximumSymbolExposurePercent: 50,
  maximumNetExposurePercent: 50,
  maximumCorrelatedExposurePercent: 50,
  dailyLossLimitUsdt: 100,
  maximumDrawdownPercent: 10,
  maximumConcurrentPositions: 1,
  maximumMarketDataAgeSeconds: 30,
  allowedTradingHoursUtc: [],
  permittedPhase7Actions: ["HOLD", "FREEZE", "EXIT"],
  validFrom: "2026-08-13T11:59:00.000Z",
  expiresAt: "2026-08-13T12:15:00.000Z",
  fingerprint: "b".repeat(64),
  createdAt: "2026-08-13T11:58:00.000Z",
} as DemoAutopilotMandate;
expect(
  "persisted mandate schema accepts its immutable persistence fields",
  DemoAutopilotMandateSchema.safeParse(mandate).success,
);
expect(
  "simulated_demo Spot boundary accepts the exact Demo authority",
  !refused(() =>
    assertSimulatedDemoValidationBoundary({
      authority: "simulated_demo",
      config,
      mandate,
    }),
  ),
);

for (const authority of [
  "binance_spot_testnet",
  "binance_futures_demo",
  "oanda_practice",
  "binance_spot_live",
  "oanda_live",
] as ExecutionAuthority[]) {
  expect(
    `${authority} is categorically outside the fixture boundary`,
    refused(() =>
      assertSimulatedDemoValidationBoundary({
        authority,
        config,
        mandate,
      }),
    ),
  );
}
expect(
  "a Live execution target is categorically outside the fixture boundary",
  refused(() =>
    assertSimulatedDemoValidationBoundary({
      authority: "simulated_demo",
      config: { ...config, executionTarget: "live" },
      mandate,
    }),
  ),
);

const observedAt = new Date("2026-08-13T12:00:00.000Z");
const first = buildPhase10ValidationCandles({ observedAt, finalPrice: 100 });
const second = buildPhase10ValidationCandles({ observedAt, finalPrice: 100 });
expect(
  "synthetic market input is deterministic",
  JSON.stringify(first) === JSON.stringify(second),
);
expect(
  "fixture candles are closed at the pinned observation time",
  first.tf1m.at(-1)?.[0] === observedAt.getTime(),
);

console.log(
  failures === 0
    ? "\nphase10 validation: all checks passed"
    : `\nphase10 validation: ${failures} FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
