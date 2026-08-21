/**
 * EXECUTION-SEAM test — P1's architectural claim, checked in isolation.
 *
 * The claim: everything up to the approved TradePlan is identical in every
 * mode, and swapping what happens AFTER the plan requires touching nothing in
 * the intelligence pipeline. If that holds, a stand-in executor can replace
 * LiveExecutor and receive the exact plan the engine produced.
 *
 * Also pins the client-order-id format. That id is what makes a timed-out
 * order findable instead of blindly resubmittable, and a market order
 * resubmitted because its id was rejected doubles a real position — so the
 * format is a safety property, not cosmetics.
 *
 * Pure — no DB, no network, no engine.
 *
 * Run:  tsx harness/execution.test.ts   (exit 0 = pass)
 */
import { LiveExecutor } from "../src/lib/execution/liveExecutor";
import { makeClientOrderId } from "../src/lib/execution/ids";
import type { ExecutionRequest, ExecutionResult, TradeExecutor, } from "../src/lib/execution/executor";

let failures = 0;
function expect(name: string, cond: boolean, detail = "") {
  if (!cond) {
    failures++;
    console.error(`✗  ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    console.log(`✓  ${name}`);
  }
}

const samplePlan = {
  strategyId: "trend-pullback",
  strategyName: "Trend Pullback",
  symbol: "BTC/USDT",
  side: "long",
  confidence: 82,
  entryPrice: 60200,
  slPrice: 59800,
  tpPrice: 61200,
  qty: 0.05,
  leverage: 3,
  expectedHoldSeconds: 3600,
  maxHoldSeconds: 7200,
  regime: "trend",
  netRewardRisk: 2.4,
  report: {
    summary: "s",
    marketView: [],
    entryLogic: [],
    riskLogic: [],
    exitLogic: [],
    checks: [],
  },
} as any;

const req: ExecutionRequest = {
  symbol: "BTCUSDT",
  plan: samplePlan,
  row: { confidence: 82, regime: "trend" } as any,
  config: { marketType: "spot" } as any,
  now: new Date("2025-06-01T00:00:00Z"),
};

// ── LiveExecutor delegates, unchanged ───────────────────────────────────────

let seen: ExecutionRequest | null = null;
const live = new LiveExecutor(
  async (r) => {
    seen = r;
    return {
      entered: true,
      reason: "filled",
      correlationId: "corr-1",
      tradeId: 7,
    };
  },
  async () => ({ allowed: true, commandFingerprint: "command-fingerprint" }),
);

expect("LiveExecutor identifies itself as live", live.kind === "live");

const liveResult = await live.execute(req);
expect("LiveExecutor passes the request through untouched", seen === req);
expect(
  "LiveExecutor returns the order path's result",
  liveResult.entered && liveResult.tradeId === 7,
);
expect(
  "result carries the correlation id",
  liveResult.correlationId === "corr-1",
);

// ── A different executor slots in with no pipeline changes ──────────────────
// This is the whole point of the seam: Demo and Co-Pilot will be this shape.

class RecordingExecutor implements TradeExecutor {
  readonly kind = "recommend" as const;
  received: ExecutionRequest[] = [];
  async execute(r: ExecutionRequest): Promise<ExecutionResult> {
    this.received.push(r);
    return {
      entered: false,
      reason: "recorded as a recommendation, not executed",
    };
  }
}

const rec = new RecordingExecutor();
const recResult = await rec.execute(req);
expect(
  "a non-live executor satisfies the same interface",
  rec.kind === "recommend",
);
expect(
  "it receives the identical plan the engine produced",
  rec.received[0]!.plan === samplePlan,
);
expect("it can decline to open a position", recResult.entered === false);
expect("declining still explains itself", recResult.reason.length > 0);

// Both executors saw the same plan object — nothing upstream had to change.
expect(
  "live and non-live executors consume one identical plan",
  seen!.plan === rec.received[0]!.plan,
);

// ── Client order id format ──────────────────────────────────────────────────
// Binance accepts ^[\.A-Z\:/a-z0-9_-]{1,36}$ for newClientOrderId.
const BINANCE_CLIENT_ORDER_ID = /^[.A-Z:/a-z0-9_-]{1,36}$/;

const ids = Array.from({ length: 500 }, () => makeClientOrderId(990042));
expect(
  "client order ids match Binance's accepted charset",
  ids.every((id) => BINANCE_CLIENT_ORDER_ID.test(id)),
  ids[0],
);
expect(
  "client order ids fit the 36-char cap",
  ids.every((id) => id.length <= 36),
  `longest ${Math.max(...ids.map((i) => i.length))}`,
);
expect(
  "client order ids are unique across rapid calls",
  new Set(ids).size === ids.length,
);
expect(
  "client order id is namespaced to the account",
  ids[0]!.startsWith("tc-990042-"),
  ids[0],
);
// A large userId must not push the id past the cap.
const bigId = makeClientOrderId(2_147_483_647);
expect(
  "stays legal for the largest int4 userId",
  BINANCE_CLIENT_ORDER_ID.test(bigId) && bigId.length <= 36,
  `${bigId} (${bigId.length})`,
);

console.log(
  failures === 0
    ? "\nAll execution-seam checks passed."
    : `\n${failures} FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
