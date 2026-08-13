import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
const WORKSPACE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const RUNBOOK_PATH = resolve(WORKSPACE_ROOT, "docs/phase-10-demo-autopilot.md");
const ROOT_ENV_PATH = resolve(WORKSPACE_ROOT, ".env");
const CLI_STAGES = [
  "before-restart",
  "after-restart",
  "confirm-suspended",
] as const;
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

function smokeCliStage(stage: (typeof CLI_STAGES)[number]): {
  passed: boolean;
  detail: string;
} {
  const pnpmEntrypoint = process.env.npm_execpath;
  if (!pnpmEntrypoint) {
    return {
      passed: false,
      detail: "npm_execpath is unavailable; run this harness through pnpm",
    };
  }

  const result = spawnSync(
    process.execPath,
    [
      pnpmEntrypoint,
      "--filter",
      "@workspace/api-server",
      "run",
      "validate:phase10",
      stage,
    ],
    {
      cwd: WORKSPACE_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL:
          "postgres://phase10_cli_smoke:unused@127.0.0.1:1/phase10_cli_smoke",
      },
      timeout: 30_000,
    },
  );
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const expectedBoundary = "Missing required --user-id option";
  const passed = result.status === 1 && output.includes(expectedBoundary);
  return {
    passed,
    detail: result.error?.message ?? output.trim().slice(-500),
  };
}

const runbook = readFileSync(RUNBOOK_PATH, "utf8");
const createdRootEnv = !existsSync(ROOT_ENV_PATH);
if (createdRootEnv) {
  writeFileSync(
    ROOT_ENV_PATH,
    "# Temporary file for the Phase 10 CLI argument-wiring smoke test.\n",
    { flag: "wx" },
  );
}
try {
  for (const stage of CLI_STAGES) {
    expect(
      `runbook forwards ${stage} as the first script argument`,
      runbook.includes(
        `pnpm --filter @workspace/api-server run validate:phase10 ${stage}`,
      ) &&
        !runbook.includes(
          `pnpm --filter @workspace/api-server run validate:phase10 -- ${stage}`,
        ),
    );
    const smoke = smokeCliStage(stage);
    expect(
      `${stage} reaches the Phase 10 CLI before the database boundary`,
      smoke.passed,
      smoke.detail,
    );
  }
} finally {
  if (createdRootEnv) unlinkSync(ROOT_ENV_PATH);
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
