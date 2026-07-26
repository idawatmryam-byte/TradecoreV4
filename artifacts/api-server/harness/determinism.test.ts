/**
 * DETERMINISM test — the P0 guarantee, made mechanical.
 *
 * Two halves:
 *
 *  1. FINGERPRINT. The same decision content must always hash to the same
 *     value, and any change to the trade must change it. This is what makes
 *     "replay a stored snapshot and compare" a real check rather than a hope.
 *
 *  2. NO WALL CLOCK IN THE DECISION CORE. Two strategies used to fall back to
 *     Date.now()/new Date() when the 1m candle array was empty, which meant
 *     the same stored snapshot could decide differently on replay. Both now
 *     fail closed. These cases lock that in.
 *
 * Pure — no DB, no network.
 *
 * Run:  tsx harness/determinism.test.ts   (exit 0 = pass)
 */
import {
  canonicalJson,
  fingerprintPayload,
  planFingerprint,
  FINGERPRINT_VERSION,
} from "../src/lib/plan/fingerprint";
import { evalCondition, indicatorValue } from "../src/lib/strategies/custom";
import { LondonBreakoutStrategy } from "../src/lib/strategies/london-breakout";
import type { TradePlan } from "../src/lib/strategies/base";

let failures = 0;
function expect(name: string, cond: boolean, detail = "") {
  if (!cond) {
    failures++;
    console.error(`✗  ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    console.log(`✓  ${name}`);
  }
}

// ── canonicalJson ───────────────────────────────────────────────────────────

expect(
  "canonicalJson: key order does not affect output",
  canonicalJson({ b: 1, a: 2 }) === canonicalJson({ a: 2, b: 1 }),
);
expect(
  "canonicalJson: nested key order does not affect output",
  canonicalJson({ x: { d: 1, c: 2 } }) === canonicalJson({ x: { c: 2, d: 1 } }),
);
expect(
  "canonicalJson: array ORDER is significant",
  canonicalJson([1, 2]) !== canonicalJson([2, 1]),
);
expect("canonicalJson: undefined members are dropped", canonicalJson({ a: 1, b: undefined }) === '{"a":1}');
expect("canonicalJson: -0 and 0 hash the same", canonicalJson(-0) === canonicalJson(0));
expect("canonicalJson: null survives", canonicalJson({ a: null }) === '{"a":null}');

let threw = false;
try { canonicalJson({ price: NaN }); } catch { threw = true; }
expect("canonicalJson: NaN throws rather than becoming null", threw);

threw = false;
try { canonicalJson({ price: Infinity }); } catch { threw = true; }
expect("canonicalJson: Infinity throws rather than becoming null", threw);

// ── planFingerprint ─────────────────────────────────────────────────────────

const basePlan: TradePlan = {
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
    summary: "Pullback into trend support held.",
    marketView: ["EMA9 > EMA21", "RSI 42"],
    entryLogic: ["Bounce confirmed"],
    riskLogic: ["Stop below swing low"],
    exitLogic: ["Target at prior high"],
    checks: [],
  },
} as TradePlan;

const fp = planFingerprint(1, basePlan);

expect("fingerprint: 64-char lowercase hex", /^[0-9a-f]{64}$/.test(fp));
expect("fingerprint: stable across repeated calls", planFingerprint(1, basePlan) === fp);
expect(
  "fingerprint: stable across a structurally identical clone",
  planFingerprint(1, JSON.parse(JSON.stringify(basePlan)) as TradePlan) === fp,
);

// Different user, identical decision → MUST differ, or a UNIQUE index on the
// fingerprint would silently drop one user's plan.
expect("fingerprint: differs by userId", planFingerprint(2, basePlan) !== fp);

// Every decision field must move the hash.
const mutations: Array<[string, Partial<TradePlan>]> = [
  ["strategyId", { strategyId: "mean-reversion" }],
  ["symbol", { symbol: "ETH/USDT" }],
  ["side", { side: "short" }],
  ["confidence", { confidence: 83 }],
  ["entryPrice", { entryPrice: 60201 }],
  ["slPrice", { slPrice: 59801 }],
  ["tpPrice", { tpPrice: 61201 }],
  ["qty", { qty: 0.06 }],
  ["leverage", { leverage: 4 }],
  ["expectedHoldSeconds", { expectedHoldSeconds: 3601 }],
  ["maxHoldSeconds", { maxHoldSeconds: 7201 }],
  ["regime", { regime: "range" as TradePlan["regime"] }],
  ["netRewardRisk", { netRewardRisk: 2.5 }],
];
for (const [field, patch] of mutations) {
  expect(
    `fingerprint: changing ${field} changes the hash`,
    planFingerprint(1, { ...basePlan, ...patch }) !== fp,
  );
}

// Presentation-only fields must NOT move the hash — the fingerprint is about
// the trade, not the write-up.
expect(
  "fingerprint: renaming the strategy does NOT change the hash",
  planFingerprint(1, { ...basePlan, strategyName: "Renamed For The UI" }) === fp,
);
expect(
  "fingerprint: rewording the report does NOT change the hash",
  planFingerprint(1, {
    ...basePlan,
    report: { ...basePlan.report, summary: "Completely different prose." },
  }) === fp,
);

expect("fingerprint: payload carries the algorithm version", fingerprintPayload(1, basePlan).v === FINGERPRINT_VERSION);
expect("fingerprint: payload excludes the narrative report", !("report" in fingerprintPayload(1, basePlan)));
expect("fingerprint: payload excludes the display name", !("strategyName" in fingerprintPayload(1, basePlan)));

// A plan that never went through the reward:risk gate must still hash.
const noRr = { ...basePlan };
delete (noRr as { netRewardRisk?: number }).netRewardRisk;
let hashedWithoutRr = "";
try { hashedWithoutRr = planFingerprint(1, noRr as TradePlan); } catch { /* fails below */ }
expect("fingerprint: absent netRewardRisk hashes as null, not a throw", /^[0-9a-f]{64}$/.test(hashedWithoutRr));

// ── No wall clock in the decision core ──────────────────────────────────────

const emptyMtf = { tf1m: [], tf3m: [], tf5m: [], tf15m: [], tf1h: [] } as any;
const withCandle = {
  tf1m: [[Date.UTC(2025, 5, 2, 9, 0, 0), 1.09, 1.09, 1.09, 1.09, 1]],
  tf3m: [], tf5m: [], tf15m: [], tf1h: [],
} as any;
const row = { lastPrice: 1.09, rsi: 42 } as any;

expect(
  "custom hourUtc: reads the candle's hour, not the wall clock",
  indicatorValue("hourUtc", row, withCandle) === 9,
);
expect(
  "custom hourUtc: no candle → NaN (was: wall-clock fallback)",
  Number.isNaN(indicatorValue("hourUtc", row, emptyMtf) as number),
);

// NaN must make every numeric comparison fail, so the rule fails CLOSED.
for (const op of ["gt", "gte", "lt", "lte"] as const) {
  expect(
    `custom hourUtc: '${op}' fails closed with no candle`,
    evalCondition({ indicator: "hourUtc", op, value: 7 } as any, row, emptyMtf).pass === false,
  );
}
expect(
  "custom hourUtc: still evaluates normally when a candle exists",
  evalCondition({ indicator: "hourUtc", op: "gte", value: 7 } as any, row, withCandle).pass === true,
);

const london = new LondonBreakoutStrategy();
const cfg = {} as any;
const ctx = {} as any;
expect(
  "london-breakout: no 1m candle → no setup (was: Date.now() fallback)",
  london.decide!("EUR/USD", emptyMtf, row, cfg, ctx) === null,
);

console.log(failures === 0 ? "\nAll determinism checks passed." : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
