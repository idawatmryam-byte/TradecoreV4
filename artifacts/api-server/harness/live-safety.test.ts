import {
  evaluateDrawdown,
  evaluateLiveEntrySafety,
  evaluateSafeResume,
  killSwitchApplies,
  type LiveEntrySafetyInput,
  type LiveEntrySafetyVerdict,
} from "../src/lib/execution/liveSafety";

let failures = 0;
function expect(name: string, ok: boolean): void {
  if (ok) console.log(`  PASS  ${name}`);
  else {
    console.error(`  FAIL  ${name}`);
    failures++;
  }
}

function refusalCode(verdict: LiveEntrySafetyVerdict): string | null {
  return "code" in verdict ? verdict.code : null;
}

const base: LiveEntrySafetyInput = {
  operatingMode: "NORMAL",
  reconciliationState: "HEALTHY",
  protectionState: "HEALTHY",
  globalDrawdownState: "HEALTHY",
  expectedOwnershipGeneration: 7,
  command: {
    decisionId: "recommendation:41",
    riskDecisionId: "risk:abc",
    planFingerprint: "plan:abc",
    ownershipGeneration: 7,
    brainVersion: "brain-v0",
    idempotencyKey: "approval:abc",
  },
  switches: [],
  accountDrawdown: {
    peakEquityMinor: 100_00n,
    currentEquityMinor: 90_01n,
    limitBps: 1000,
  },
};

expect(
  "healthy Live boundary allows exactly-bound command",
  evaluateLiveEntrySafety(base).allowed,
);
expect(
  "missing command identity fails closed",
  refusalCode(evaluateLiveEntrySafety({ ...base, command: null })) ===
    "LIVE_COMMAND_IDENTITY_REQUIRED",
);
expect(
  "stale ownership generation fails closed",
  refusalCode(
    evaluateLiveEntrySafety({
      ...base,
      command: { ...base.command!, ownershipGeneration: 6 },
    }),
  ) === "STALE_EXECUTION_OWNER",
);
expect(
  "global switch precedes narrower scopes deterministically",
  refusalCode(
    evaluateLiveEntrySafety({
      ...base,
      switches: [
        { scope: "SYMBOL", scopeKey: "BTCUSDT", reason: "symbol incident" },
        { scope: "GLOBAL", scopeKey: "*", reason: "platform incident" },
      ],
    }),
  ) === "KILL_SWITCH_GLOBAL",
);
const matchContext = {
  userId: 42,
  section: "crypto",
  executionAuthority: "binance_spot_live",
  marketType: "spot",
  symbol: "BTCUSDT",
  strategyId: "ema_cross",
  brainVersion: "brain-v0",
  autopilot: true,
} as const;
for (const [scope, scopeKey] of [
  ["GLOBAL", "*"],
  ["EXCHANGE", "binance_spot_live"],
  ["MARKET", "spot"],
  ["SYMBOL", "BTCUSDT"],
  ["STRATEGY_MODEL", "ema_cross"],
  ["USER", "42"],
  ["SECTION", "crypto"],
  ["AUTOPILOT", "brain-v0"],
] as const) {
  expect(
    `${scope} kill switch matches its exact Live boundary`,
    killSwitchApplies({ scope, scopeKey }, matchContext),
  );
}
expect(
  "another user's switch cannot cross the user boundary",
  !killSwitchApplies({ scope: "USER", scopeKey: "43" }, matchContext),
);
expect(
  "Autopilot switch does not affect a supervised command",
  !killSwitchApplies(
    { scope: "AUTOPILOT", scopeKey: "brain-v0" },
    { ...matchContext, autopilot: false },
  ),
);
expect(
  "exit-only blocks entries without claiming exits are disabled",
  refusalCode(
    evaluateLiveEntrySafety({ ...base, operatingMode: "EXIT_ONLY" }),
  ) === "LIVE_MODE_EXIT_ONLY",
);
expect(
  "unknown reconciliation fails closed",
  refusalCode(
    evaluateLiveEntrySafety({ ...base, reconciliationState: "UNKNOWN" }),
  ) === "RECONCILIATION_UNKNOWN",
);
expect(
  "degraded protection blocks entries",
  refusalCode(
    evaluateLiveEntrySafety({ ...base, protectionState: "DEGRADED" }),
  ) === "PROTECTION_DEGRADED",
);
expect(
  "unknown global drawdown is not converted to zero",
  refusalCode(
    evaluateLiveEntrySafety({ ...base, globalDrawdownState: "UNKNOWN" }),
  ) === "GLOBAL_DRAWDOWN_UNKNOWN",
);
expect(
  "drawdown just above threshold is healthy",
  evaluateDrawdown({
    peakEquityMinor: 100_00n,
    currentEquityMinor: 90_01n,
    limitBps: 1000,
  }).state === "HEALTHY",
);
expect(
  "drawdown exactly at threshold is breached",
  evaluateDrawdown({
    peakEquityMinor: 100_00n,
    currentEquityMinor: 90_00n,
    limitBps: 1000,
  }).state === "BREACHED",
);
expect(
  "drawdown just below threshold is breached",
  evaluateDrawdown({
    peakEquityMinor: 100_00n,
    currentEquityMinor: 89_99n,
    limitBps: 1000,
  }).state === "BREACHED",
);
expect(
  "zero peak equity remains unknown",
  evaluateDrawdown({
    peakEquityMinor: 0n,
    currentEquityMinor: 0n,
    limitBps: 1000,
  }).state === "UNKNOWN",
);
expect(
  "extreme exact integer drawdown remains deterministic",
  evaluateDrawdown({
    peakEquityMinor: 10n ** 35n,
    currentEquityMinor: 8n * 10n ** 34n,
    limitBps: 2000,
  }).state === "BREACHED",
);

const resumeBase = {
  reconciliationHealthy: true,
  protectionHealthy: true,
  accountDrawdownState: "HEALTHY",
  globalDrawdownState: "HEALTHY",
  accountEquityFresh: true,
  globalEquityFresh: true,
  ownershipGeneration: 7,
  ownerClaimed: true,
  activeKillSwitches: 0,
  operatorModeActive: false,
  providerHealthy: true,
} as const;
expect(
  "safe resume requires every prerequisite",
  evaluateSafeResume(resumeBase).allowed,
);
expect(
  "maintenance/operator authority cannot be auto-cleared",
  !evaluateSafeResume({ ...resumeBase, operatorModeActive: true }).allowed,
);
expect(
  "stale account equity blocks resume",
  !evaluateSafeResume({ ...resumeBase, accountEquityFresh: false }).allowed,
);
expect(
  "unknown global drawdown blocks resume",
  !evaluateSafeResume({
    ...resumeBase,
    globalDrawdownState: "UNKNOWN",
  }).allowed,
);
expect(
  "degraded protection blocks resume",
  !evaluateSafeResume({ ...resumeBase, protectionHealthy: false }).allowed,
);
expect(
  "active kill switch blocks resume",
  !evaluateSafeResume({ ...resumeBase, activeKillSwitches: 1 }).allowed,
);
expect(
  "stale ownership blocks resume",
  !evaluateSafeResume({ ...resumeBase, ownershipGeneration: 0 }).allowed,
);

console.log(
  failures === 0
    ? "\nlive-safety: all checks passed"
    : `\nlive-safety: ${failures} FAILED`,
);
process.exitCode = failures === 0 ? 0 : 1;
