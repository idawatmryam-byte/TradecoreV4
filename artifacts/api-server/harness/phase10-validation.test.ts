import type { BotConfig } from "@workspace/db";
import type { ExecutionAuthority } from "../src/lib/execution/authority";
import type { DemoAutopilotMandate } from "../src/lib/autopilot/contracts";
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
  executionAuthority: "simulated_demo",
  marketType: "spot",
} as DemoAutopilotMandate;
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
