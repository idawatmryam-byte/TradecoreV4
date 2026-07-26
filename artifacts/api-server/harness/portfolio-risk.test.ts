/**
 * PORTFOLIO RISK test — the gates between a plausible-looking plan and an
 * account-ending correlated bet.
 *
 * The claim this file defends: the engine's existing caps (position count,
 * aggregate dollar risk, per-symbol notional, net direction) all treat
 * BTCUSDT and ETHUSDT as two independent positions. They are not. Every
 * branch below is a distinct way that blind spot, or one of the cheap sizing
 * gates, lets real money out.
 *
 * Pure — no DB, no exchange, no clock.
 *
 * Run:  tsx harness/portfolio-risk.test.ts   (exit 0 = pass)
 */
import {
  validateSizing, dailyLogReturns, correlation, evaluateCorrelation, buildHeatMap,
  MIN_CORRELATION_OBSERVATIONS, type DailyClose,
} from "../src/lib/risk/portfolioRisk";

let failures = 0;
function expect(name: string, cond: boolean, detail = "") {
  if (!cond) {
    failures++;
    console.error(`✗  ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    console.log(`✓  ${name}`);
  }
}

const DAY = 86_400_000;
const T0 = Date.parse("2025-01-01T00:00:00Z");

/** A healthy long, so each case below changes exactly one thing. */
function sizing(over: Record<string, unknown> = {}) {
  return { balance: 1000, entryPrice: 100, slPrice: 95, qty: 1, side: "long" as const, ...over };
}

// ── Cheap sizing gates ──────────────────────────────────────────────────────
{
  expect("a healthy candidate passes every cheap gate", validateSizing(sizing()).ok);

  const noEquity = validateSizing(sizing({ balance: 0 }));
  expect("zero equity is refused", !noEquity.ok);
  expect("...as INSUFFICIENT_EQUITY", noEquity.code === "INSUFFICIENT_EQUITY", String(noEquity.code));

  const belowMin = validateSizing(sizing({ balance: 5, minEquity: 10 }));
  expect("equity under the configured floor is refused", belowMin.code === "INSUFFICIENT_EQUITY");

  // A stop AT entry makes risk exactly zero, which would sail through every
  // dollar-risk cap in the engine while being completely unprotected.
  const flatStop = validateSizing(sizing({ slPrice: 100 }));
  expect("a stop at the entry price is refused", !flatStop.ok);
  expect("...as INVALID_STOP_DISTANCE", flatStop.code === "INVALID_STOP_DISTANCE", String(flatStop.code));

  const wrongSide = validateSizing(sizing({ slPrice: 105 }));
  expect("a long's stop ABOVE entry is refused", wrongSide.code === "INVALID_STOP_DISTANCE");
  const shortWrongSide = validateSizing(sizing({ side: "short", slPrice: 95 }));
  expect("a short's stop BELOW entry is refused", shortWrongSide.code === "INVALID_STOP_DISTANCE");
  expect("a short's stop above entry is fine", validateSizing(sizing({ side: "short", slPrice: 105 })).ok);

  const dust = validateSizing(sizing({ qty: 0.0001, minQty: 0.001 }));
  expect("a size below the exchange minimum is refused", !dust.ok);
  expect("...as SIZE_ROUNDS_TO_ZERO", dust.code === "SIZE_ROUNDS_TO_ZERO", String(dust.code));
  expect("exactly at the minimum size is allowed", validateSizing(sizing({ qty: 0.001, minQty: 0.001 })).ok);

  const stale = validateSizing(sizing({ equityAgeMs: 120_000, maxEquityAgeMs: 60_000 }));
  expect("an equity reading past its freshness budget is refused", !stale.ok);
  expect("...as STALE_EQUITY", stale.code === "STALE_EQUITY", String(stale.code));
  expect("a fresh equity reading passes", validateSizing(sizing({ equityAgeMs: 5_000, maxEquityAgeMs: 60_000 })).ok);

  // The dangerous default: treating a missing rate as 1.0 would size a
  // non-USD instrument as though the conversion were free.
  const noFx = validateSizing(sizing({ quoteToAccountRate: null }));
  expect("a missing FX conversion rate is refused, not assumed to be 1", !noFx.ok);
  expect("...as MISSING_FX_CONVERSION", noFx.code === "MISSING_FX_CONVERSION", String(noFx.code));
  expect("an explicit rate of 1 is fine", validateSizing(sizing({ quoteToAccountRate: 1 })).ok);

  expect("every refusal explains itself in prose", [noEquity, flatStop, dust, stale, noFx].every((v) => (v.reason ?? "").length > 10));
}

// ── Daily log returns ───────────────────────────────────────────────────────
{
  const closes: DailyClose[] = [
    { timestamp: T0, close: 100 },
    { timestamp: T0 + DAY, close: 110 },
    { timestamp: T0 + 2 * DAY, close: 121 },
  ];
  const r = dailyLogReturns(closes);
  expect("n closes produce n−1 returns", r.size === 2, String(r.size));
  expect("a +10% day is ln(1.1)", Math.abs(r.get(Math.floor((T0 + DAY) / DAY))! - Math.log(1.1)) < 1e-12);
  expect("returns are keyed by the day they END on", r.has(Math.floor((T0 + 2 * DAY) / DAY)));

  // The forex weekend case: a gap must NOT silently become a 3-day "daily"
  // return, or it gets compared against crypto's true 1-day moves.
  const gapped: DailyClose[] = [
    { timestamp: T0, close: 100 },
    { timestamp: T0 + DAY, close: 101 },
    { timestamp: T0 + 4 * DAY, close: 130 },  // weekend gap
    { timestamp: T0 + 5 * DAY, close: 131 },
  ];
  const gr = dailyLogReturns(gapped);
  expect("a multi-day gap yields no return for that span", gr.size === 2, String(gr.size));
  expect("the huge cross-gap move is excluded, not recorded as one day",
    ![...gr.values()].some((v) => Math.abs(v) > 0.2), JSON.stringify([...gr.values()]));

  expect("unsorted input is handled", dailyLogReturns([...closes].reverse()).size === 2);
  expect("a zero close is skipped rather than producing -Infinity",
    [...dailyLogReturns([{ timestamp: T0, close: 0 }, { timestamp: T0 + DAY, close: 10 }]).values()].every(Number.isFinite));
  expect("a single close produces no returns", dailyLogReturns([{ timestamp: T0, close: 100 }]).size === 0);
}

// ── Correlation ─────────────────────────────────────────────────────────────
function series(values: number[], startDay = 0): Map<number, number> {
  const m = new Map<number, number>();
  values.forEach((v, k) => m.set(startDay + k, v));
  return m;
}
const N = MIN_CORRELATION_OBSERVATIONS;

{
  const base = Array.from({ length: N }, (_, k) => Math.sin(k) * 0.01);

  const identical = correlation(series(base), series(base));
  expect("a series against itself is +1", Math.abs(identical! - 1) < 1e-9, String(identical));

  const inverted = correlation(series(base), series(base.map((v) => -v)));
  expect("a mirrored series is −1", Math.abs(inverted! + 1) < 1e-9, String(inverted));

  const scaled = correlation(series(base), series(base.map((v) => v * 3)));
  expect("correlation is scale-invariant", Math.abs(scaled! - 1) < 1e-9, String(scaled));

  expect("result never escapes [−1, 1]", [identical!, inverted!, scaled!].every((v) => v >= -1 && v <= 1));

  // Below the observation floor the honest answer is "we do not know" — NOT 0,
  // which would read as "measured, and they are unrelated".
  const thin = correlation(series(base.slice(0, N - 1)), series(base.slice(0, N - 1)));
  expect("one observation short of the floor returns null", thin === null, String(thin));
  expect("exactly at the floor measures", correlation(series(base), series(base)) !== null);

  const flat = correlation(series(base), series(new Array(N).fill(0.01)));
  expect("a flat series returns null, not a divide-by-zero", flat === null, String(flat));

  // Overlap is computed on shared DAYS, not by index — the cross-asset case.
  const offset = correlation(series(base), series(base, 1000));
  expect("series with no shared days return null", offset === null, String(offset));

  const partial = correlation(series(base, 0), series(base, 5));
  expect("partial overlap below the floor returns null", partial === null, String(partial));

  const longA = Array.from({ length: 40 }, (_, k) => Math.sin(k) * 0.01);
  const shared = correlation(series(longA, 0), series(longA.slice(5), 5));
  expect("partial overlap ABOVE the floor measures on shared days only", shared !== null && Math.abs(shared - 1) < 1e-9, String(shared));
}

// ── Correlated exposure gate ────────────────────────────────────────────────
function corrGate(over: Record<string, unknown> = {}) {
  return {
    candidate: { symbol: "BTCUSDT", side: "long" as const, notionalUsdt: 300 },
    open: [{ symbol: "ETHUSDT", side: "long" as const, notionalUsdt: 300 }],
    correlations: new Map<string, number | null>([["ETHUSDT", 0.9]]),
    balance: 1000,
    maxCorrelatedExposurePercent: 50,
    threshold: 0.7,
    unknownPolicy: "allow" as const,
    ...over,
  };
}

{
  // 300 + 300 = 600 against a 500 cap → refused.
  const blocked = evaluateCorrelation(corrGate());
  expect("two correlated longs breaching the cap are refused", !blocked.ok);
  expect("the cluster sums both positions", blocked.clusterNotionalUsdt === 600, String(blocked.clusterNotionalUsdt));
  expect("the correlated symbol is named", blocked.clusterSymbols.includes("ETHUSDT"));
  expect("the refusal quantifies the breach", /600\.00.*500\.00/.test(blocked.reason ?? ""), blocked.reason);

  // The hedge case — same |r|, opposite sides, so NOT additive.
  const hedge = evaluateCorrelation(corrGate({ open: [{ symbol: "ETHUSDT", side: "short", notionalUsdt: 300 }] }));
  expect("a positively-correlated position on the OPPOSITE side is a hedge, not exposure", hedge.ok);
  expect("...and is excluded from the cluster", hedge.clusterSymbols.length === 0);
  expect("...leaving only the candidate's own notional", hedge.clusterNotionalUsdt === 300);

  // Negative correlation + opposite side is the SAME bet (long EUR_USD /
  // short USD_CHF). Missing this is the subtle failure.
  const inverseSame = evaluateCorrelation(corrGate({
    open: [{ symbol: "USDCHF", side: "short", notionalUsdt: 300 }],
    correlations: new Map([["USDCHF", -0.9]]),
  }));
  expect("a negatively-correlated position on the opposite side IS the same bet", !inverseSame.ok);
  expect("...and joins the cluster", inverseSame.clusterSymbols.includes("USDCHF"));

  const inverseHedge = evaluateCorrelation(corrGate({
    open: [{ symbol: "USDCHF", side: "long", notionalUsdt: 300 }],
    correlations: new Map([["USDCHF", -0.9]]),
  }));
  expect("negative correlation on the SAME side is a hedge", inverseHedge.ok);

  const weak = evaluateCorrelation(corrGate({ correlations: new Map([["ETHUSDT", 0.3]]) }));
  expect("a weakly-correlated position is not clustered", weak.ok);

  const atThreshold = evaluateCorrelation(corrGate({ correlations: new Map([["ETHUSDT", 0.7]]) }));
  expect("exactly at the threshold counts as correlated", !atThreshold.ok);

  const underCap = evaluateCorrelation(corrGate({ maxCorrelatedExposurePercent: 60 }));
  expect("the same cluster under a looser cap is allowed", underCap.ok, String(underCap.clusterNotionalUsdt));

  expect("no open positions means only the candidate counts",
    evaluateCorrelation(corrGate({ open: [], correlations: new Map() })).clusterNotionalUsdt === 300);
}

// ── Unmeasurable pairs are a policy decision, never a silent zero ───────────
{
  const unknown = new Map<string, number | null>([["ETHUSDT", null]]);

  const allowed = evaluateCorrelation(corrGate({ correlations: unknown }));
  expect("under 'allow', an unmeasurable pair does not block", allowed.ok);
  expect("...and is NOT treated as correlated", allowed.clusterSymbols.length === 0);
  expect("...but is surfaced as unmeasured, so the UI can say so", allowed.unmeasured.includes("ETHUSDT"));

  const blocked = evaluateCorrelation(corrGate({ correlations: unknown, unknownPolicy: "block" }));
  expect("under 'block', an unmeasurable pair refuses the trade", !blocked.ok);
  expect("...and says it refused rather than traded blind", /could not be measured/.test(blocked.reason ?? ""), blocked.reason);

  // The bug this guards: null silently coerced to 0 would read as "measured,
  // and unrelated" — an unearned claim of independence.
  expect("a null correlation is never scored as 0-and-therefore-safe",
    allowed.unmeasured.length === 1 && allowed.clusterSymbols.length === 0);
}

// ── Heat map ────────────────────────────────────────────────────────────────
{
  const base = Array.from({ length: N }, (_, k) => Math.sin(k) * 0.01);
  const returns = new Map<string, Map<number, number>>([
    ["BTCUSDT", series(base)],
    ["ETHUSDT", series(base.map((v) => v * 2))],
    ["XRPUSDT", series(base.slice(0, 3))],       // too little history
  ]);
  const cells = buildHeatMap(returns);
  expect("upper triangle only — 3 symbols give 3 pairs", cells.length === 3, String(cells.length));
  expect("no self-pairs on the diagonal", cells.every((c) => c.a !== c.b));
  expect("no duplicated pair in both orders",
    new Set(cells.map((c) => [c.a, c.b].sort().join("|"))).size === cells.length);

  const btcEth = cells.find((c) => c.a === "BTCUSDT" && c.b === "ETHUSDT");
  expect("a measurable pair carries its correlation", Math.abs(btcEth!.correlation! - 1) < 1e-9, String(btcEth?.correlation));

  const thin = cells.filter((c) => c.a === "XRPUSDT" || c.b === "XRPUSDT");
  expect("pairs without enough history are null, never a number",
    thin.length === 2 && thin.every((c) => c.correlation === null));

  expect("an empty matrix produces no cells", buildHeatMap(new Map()).length === 0);
  expect("a single symbol produces no pairs", buildHeatMap(new Map([["BTCUSDT", series(base)]])).length === 0);
}

console.log(failures === 0 ? "\nAll portfolio-risk checks passed." : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
