/**
 * KNOWLEDGE test — the guarantees that separate a knowledge layer from a
 * plausible-number generator.
 *
 * Four claims are defended here, and each one has a specific way of failing
 * silently in production, which is why they are asserted rather than trusted:
 *
 *   LOOK-AHEAD  an as-of-T query that lets a Friday outcome inform a Tuesday
 *               view makes every metric better, breaks nothing, and is
 *               invisible until real money disagrees.
 *   GATING      a win rate from nine trades renders exactly like a win rate
 *               from nine hundred.
 *   MULTIPLICITY slice finely enough and some cell always looks brilliant.
 *   SIMILARITY  un-normalised cosine and a top-N slice will both return
 *               confident matches on an account that has none.
 *
 * Pure — no DB, no exchange, no clock.
 *
 * Run:  tsx harness/knowledge.test.ts   (exit 0 = pass)
 */
import {
  asOfView, chronologicalSplit, assertNoLookahead,
} from "../src/lib/knowledge/pointInTime";
import {
  buildKnowledge, summarise, sessionOf, volatilityBucketOf,
  MIN_CELL_SAMPLES, type TradeObservation,
} from "../src/lib/knowledge/cells";
import { binomialTest, benjaminiHochberg, wilsonInterval } from "../src/lib/knowledge/stats";
import {
  calibrationReport, fitIsotonic, applyCalibration, brierScore, logLoss,
  expectedCalibrationError, reliabilityBins, toCalibrationPoints,
  MIN_CALIBRATION_SAMPLES, type CalibrationPoint,
} from "../src/lib/knowledge/calibration";
import {
  findSimilarTrades, normalisationStats, standardise, cosine,
  SIMILARITY_FLOOR, MIN_POOL_SIZE,
} from "../src/lib/knowledge/similarity";

let failures = 0;
function expect(name: string, cond: boolean, detail = "") {
  if (!cond) {
    failures++;
    console.error(`✗  ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    console.log(`✓  ${name}`);
  }
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.parse("2025-01-06T09:00:00Z"); // a Monday, London session

/** A closed trade. Every field defaulted so each case changes exactly one thing. */
function trade(over: Partial<TradeObservation> = {}): TradeObservation {
  const entryTime = over.entryTime ?? T0;
  return {
    tradeId: Math.floor(Math.random() * 1e9),
    entryTime,
    closedAt: over.closedAt ?? entryTime + HOUR,
    symbol: "BTCUSDT",
    strategyId: "momentum",
    regime: "trending_up",
    atrPercent: 0.8,
    pnl: 10,
    plannedRisk: 10,
    exitReason: "take_profit",
    confidence: 70,
    features: { confidence: 70, rsi: 55, adx: 25, atrPercent: 0.8, volumeRatio: 1.2, macdHistogram: 0.4 },
    ...over,
  };
}

/** n trades, `wins` of which made money. Spaced a day apart so ordering is unambiguous. */
function series(n: number, wins: number, over: Partial<TradeObservation> = {}): TradeObservation[] {
  return Array.from({ length: n }, (_, i) => trade({
    entryTime: T0 + i * DAY,
    closedAt: T0 + i * DAY + HOUR,
    pnl: i < wins ? 10 : -10,
    exitReason: i < wins ? "take_profit" : "stop_loss",
    ...over,
  }));
}

// ── Point-in-time: the look-ahead guarantee ─────────────────────────────────
{
  const rows = series(10, 5);
  const cut = T0 + 4 * DAY + HOUR; // through the 5th trade

  const view = asOfView(rows, cut);
  expect("as-of-T keeps only outcomes settled at or before the cut", view.rows.length === 5, `got ${view.rows.length}`);
  expect("...and every kept row really is in the past", view.rows.every((r) => r.closedAt <= cut));
  expect("...with the boundary inclusive", asOfView(rows, T0 + HOUR).rows.length === 1);

  // The leak this guards: a trade OPENED in the past but SETTLED in the future
  // teaches nothing yet, and using entry time would admit it.
  const straddling = trade({ entryTime: T0 - DAY, closedAt: T0 + 30 * DAY });
  expect(
    "a trade opened before the cut but closed after it is excluded",
    asOfView([straddling], T0).rows.length === 0,
  );

  const unplaceable = trade({ closedAt: Number.NaN });
  expect("a row with no usable timestamp is dropped, not assumed old", asOfView([unplaceable], T0 + DAY).rows.length === 0);

  expect("views come out oldest-first", asOfView([...rows].reverse(), cut).rows.every(
    (r, i, a) => i === 0 || a[i - 1]!.closedAt <= r.closedAt,
  ));

  let threw = false;
  try { assertNoLookahead({ asOf: T0, rows: [trade({ closedAt: T0 + DAY })] }); } catch { threw = true; }
  expect("a hand-built view containing the future is caught at runtime", threw);

  const { train, validation } = chronologicalSplit(asOfView(rows, T0 + 100 * DAY), 0.7);
  expect("the split is 70/30", train.rows.length === 7 && validation.rows.length === 3);
  expect(
    "...and strictly chronological — every training row predates every validation row",
    train.rows[train.rows.length - 1]!.closedAt < validation.rows[0]!.closedAt,
  );
}

// ── Sample gating ───────────────────────────────────────────────────────────
{
  const thin = summarise(series(MIN_CELL_SAMPLES - 1, 20));
  expect("one trade below the gate is gated", thin.gated);
  expect("...and reports NO win rate rather than a provisional one", thin.winRate === null);
  expect("...nor expectancy, profit factor or average R", thin.expectancyUsdt === null && thin.profitFactor === null && thin.avgR === null);
  expect("...but still reports its counts, which are facts", thin.samples === 29 && thin.wins === 20 && thin.losses === 9);
  expect("...and its net P&L, also a fact", thin.netPnlUsdt === 20 * 10 - 9 * 10);

  const atGate = summarise(series(MIN_CELL_SAMPLES, 18));
  expect("exactly at the gate it opens", !atGate.gated && atGate.winRate === 0.6, String(atGate.winRate));
  expect("...with a Wilson interval attached, not a bare point estimate",
    atGate.winRateLow != null && atGate.winRateHigh != null && atGate.winRateLow < 0.6 && atGate.winRateHigh > 0.6);

  // Scratches leave the denominator rather than counting as losses — the
  // kernel's definition, and the whole point of having one.
  const withScratches = summarise([
    ...series(20, 20),
    ...series(10, 0, { exitReason: "break_even", pnl: 0 }),
  ]);
  expect("break-even washes are scratches, not losses", withScratches.scratches === 10 && withScratches.losses === 0);
  expect("...and are excluded from the win-rate denominator", withScratches.winRate === 1);

  const empty = summarise([]);
  expect("an empty bucket is gated and silent", empty.gated && empty.winRate === null && empty.samples === 0);
}

// ── Statistics ──────────────────────────────────────────────────────────────
{
  // Exact binomial, checked against hand-computable cases.
  expect("a perfectly typical result is not significant", binomialTest(15, 30, 0.5) > 0.9, String(binomialTest(15, 30, 0.5)));
  expect("30 wins from 30 against a fair coin is decisive", binomialTest(30, 30, 0.5) < 1e-8);
  expect("...and equals 2^-30 exactly (both tails: all-wins and all-losses)",
    Math.abs(binomialTest(30, 30, 0.5) - 2 * 0.5 ** 30) < 1e-15);
  expect("no data yields no evidence", binomialTest(0, 0, 0.5) === 1);
  expect("the test is two-sided — a poor cell is as detectable as a good one",
    Math.abs(binomialTest(5, 30, 0.5) - binomialTest(25, 30, 0.5)) < 1e-12);

  const w = wilsonInterval(15, 30)!;
  expect("Wilson brackets the estimate", w.low < 0.5 && w.high > 0.5);
  expect("...and stays finite at 100%, where Wald would claim certainty", (() => {
    const perfect = wilsonInterval(30, 30)!;
    return perfect.low > 0.85 && perfect.low < 1 && perfect.high === 1;
  })());

  // Benjamini–Hochberg over 100 null tests: uniform p-values, no real effects.
  const nulls = Array.from({ length: 100 }, (_, i) => ({ item: i, pValue: (i + 0.5) / 100 }));
  const adjusted = benjaminiHochberg(nulls, 0.1);
  expect("BH finds nothing in 100 pure-noise tests", adjusted.every((a) => !a.significant));
  expect("...even though 5 of them clear a naive p < 0.05",
    nulls.filter((t) => t.pValue < 0.05).length === 5);
  expect("...and q is never below p", adjusted.every((a) => a.qValue >= a.pValue - 1e-12));
  expect("...and q is monotone in p", (() => {
    const byP = [...adjusted].sort((a, b) => a.pValue - b.pValue);
    return byP.every((a, i) => i === 0 || byP[i - 1]!.qValue <= a.qValue + 1e-12);
  })());

  const oneReal = benjaminiHochberg([{ item: "real", pValue: 1e-9 }, ...nulls], 0.1);
  expect("a genuine effect survives the correction", oneReal[0]!.significant);
  expect("...and it alone", oneReal.filter((a) => a.significant).length === 1);
  expect("an empty family is handled", benjaminiHochberg([]).length === 0);
}

// ── Cells end to end ────────────────────────────────────────────────────────
{
  // A record where one symbol genuinely differs: BTC 50%, ETH 90%.
  const rows = [
    ...series(60, 30, { symbol: "BTCUSDT" }),
    ...series(60, 54, { symbol: "ETHUSDT", entryTime: T0 + 100 * DAY, closedAt: T0 + 100 * DAY + HOUR }),
  ];
  const report = buildKnowledge(asOfView(rows, T0 + 500 * DAY));

  expect("the baseline is the whole account, not a cell", report.baselineWinRate === 0.7, String(report.baselineWinRate));
  expect("every dimension produced cells", new Set(report.cells.map((c) => c.dimension)).size >= 3);

  const eth = report.cells.find((c) => c.key === "ETHUSDT|momentum")!;
  const btc = report.cells.find((c) => c.key === "BTCUSDT|momentum")!;
  expect("the outperforming symbol is measured at 90%", eth.winRate === 0.9, String(eth.winRate));
  expect("the underperforming one at 50%", btc.winRate === 0.5, String(btc.winRate));
  expect("both cleared the gate", !eth.gated && !btc.gated);
  expect("both were tested", eth.significance != null && btc.significance != null);
  expect("a genuine 20-point gap over 60 trades is flagged", eth.significance!.significant, `q=${eth.significance!.qValue}`);
  expect("...and results are ordered strongest-evidence first", report.cells[0]!.significance?.significant === true);

  // A thin cell must never be tested — that is the multiplicity leak.
  const withThin = buildKnowledge(asOfView([...rows, ...series(5, 5, { symbol: "SOLUSDT" })], T0 + 500 * DAY));
  const sol = withThin.cells.find((c) => c.key === "SOLUSDT|momentum")!;
  expect("a 5-trade cell appears (so 'not enough data' is visible)", sol != null && sol.samples === 5);
  expect("...gated, with no win rate", sol.gated && sol.winRate === null);
  expect("...and never enters the significance family", sol.significance === null);
  expect("...so a 5-for-5 streak is never called an edge", !withThin.cells.some((c) => c.key === "SOLUSDT|momentum" && c.significance?.significant));

  // No baseline ⇒ nothing may be called significant.
  const tiny = buildKnowledge(asOfView(series(10, 9), T0 + 500 * DAY));
  expect("with no trustworthy baseline, no cell is tested", tiny.baselineWinRate === null && tiny.cellsTested === 0);
  expect("...and every cell's significance is null", tiny.cells.every((c) => c.significance === null));

  // Missing facts exclude a trade from a dimension rather than inventing one.
  const noRegime = buildKnowledge(asOfView(series(40, 20, { regime: null }), T0 + 500 * DAY));
  expect("trades with no recorded regime produce no regime cells",
    !noRegime.cells.some((c) => c.dimension === "strategy_regime"));
  expect("...but still populate the session cells", noRegime.cells.some((c) => c.dimension === "session"));

  const noStrategy = buildKnowledge(asOfView(series(40, 20, { strategyId: null }), T0 + 500 * DAY));
  expect("unattributed trades are absent from strategy dimensions, not filed under 'unknown'",
    !noStrategy.cells.some((c) => c.dimension === "symbol_strategy" || c.dimension === "strategy_regime"));

  expect("a report is stamped with its own cut", report.asOf === T0 + 500 * DAY);
}

// ── Bucketing ───────────────────────────────────────────────────────────────
{
  expect("00:00 UTC is the Asian session", sessionOf(Date.parse("2025-03-03T00:30:00Z")) === "asian");
  expect("08:00 UTC is London", sessionOf(Date.parse("2025-03-03T08:00:00Z")) === "london");
  expect("15:00 UTC is New York", sessionOf(Date.parse("2025-03-03T15:00:00Z")) === "new_york");
  expect("22:00 UTC is off hours", sessionOf(Date.parse("2025-03-03T22:00:00Z")) === "off_hours");
  expect("session boundaries are half-open — 07:00 is London, not Asian", sessionOf(Date.parse("2025-03-03T07:00:00Z")) === "london");

  expect("ATR 0.2% is low volatility", volatilityBucketOf(0.2) === "low");
  expect("ATR 1.0% is normal", volatilityBucketOf(1.0) === "normal");
  expect("ATR 2.0% is high", volatilityBucketOf(2.0) === "high");
  expect("a missing ATR has no bucket rather than a default one", volatilityBucketOf(null) === null);
}

// ── Calibration ─────────────────────────────────────────────────────────────
{
  const pt = (predicted: number, actual: 0 | 1, i: number): CalibrationPoint =>
    ({ closedAt: T0 + i * HOUR, predicted, actual });

  expect("a perfect forecast scores 0 Brier", brierScore([pt(1, 1, 0), pt(0, 0, 1)]) === 0);
  expect("a coin flip scores 0.25", brierScore([pt(0.5, 1, 0), pt(0.5, 0, 1)]) === 0.25);
  expect("log loss of a confident miss is large but finite",
    (() => { const l = logLoss([pt(0, 1, 0)]); return l != null && Number.isFinite(l) && l > 10; })());
  expect("empty input scores nothing, not zero", brierScore([]) === null && logLoss([]) === null);

  // Perfectly calibrated: 30% of the 0.3-bin win, 70% of the 0.7-bin.
  const calibrated = [
    ...Array.from({ length: 100 }, (_, i) => pt(0.3, i < 30 ? 1 : 0, i)),
    ...Array.from({ length: 100 }, (_, i) => pt(0.7, i < 70 ? 1 : 0, 100 + i)),
  ];
  const ece = expectedCalibrationError(calibrated)!;
  expect("a perfectly calibrated set has ~zero ECE", ece < 1e-9, String(ece));

  const overconfident = Array.from({ length: 100 }, (_, i) => pt(0.9, i < 50 ? 1 : 0, i));
  expect("a 0.9 forecast that wins half the time shows ECE ≈ 0.4",
    Math.abs(expectedCalibrationError(overconfident)! - 0.4) < 1e-9);

  const bins = reliabilityBins(calibrated);
  expect("bins cover [0,1] with the top bin closed", bins.length === 10 && bins[9]!.high === 1);
  expect("a forecast of exactly 1.0 lands in the top bin", reliabilityBins([pt(1, 1, 0)])[9]!.count === 1);
  expect("empty bins are kept, because a gap is informative", bins.filter((b) => b.count === 0).length === 8);

  // Isotonic must be monotone even when the raw data is not.
  const nonMonotone = [
    ...Array.from({ length: 20 }, (_, i) => pt(0.2, i < 16 ? 1 : 0, i)),      // 80% at a LOW score
    ...Array.from({ length: 20 }, (_, i) => pt(0.5, i < 4 ? 1 : 0, 20 + i)),  // 20% in the middle
    ...Array.from({ length: 20 }, (_, i) => pt(0.8, i < 18 ? 1 : 0, 40 + i)), // 90% at a high score
  ];
  const model = fitIsotonic(nonMonotone);
  expect("the fitted curve never decreases", model.knots.every((k, i) => i === 0 || model.knots[i - 1]!.y <= k.y));
  expect("...pooling the inverted patch flat instead of reporting a dip",
    applyCalibration(model, 0.2) === applyCalibration(model, 0.5));
  expect("...while keeping the genuine rise", applyCalibration(model, 0.8) > applyCalibration(model, 0.2));
  expect("outside the fitted range it extends flat, not extrapolated",
    applyCalibration(model, 0.99) === applyCalibration(model, 0.8) && applyCalibration(model, 0.01) === applyCalibration(model, 0.2));
  expect("an unfitted model falls back to the base rate", applyCalibration(fitIsotonic([]), 0.7) === 0.5);

  // The gate is on the validation split, so ~100 trades are needed at 70/30.
  const gated = calibrationReport(asOfView(series(60, 30), T0 + 500 * DAY));
  expect("60 trades is not enough to publish a calibration", gated.gated);
  expect("...every score is null", gated.raw.brier === null && gated.calibrated.brier === null && gated.model === null);
  expect("...and it says how many more are needed", gated.samplesNeeded === MIN_CALIBRATION_SAMPLES - 18, String(gated.samplesNeeded));

  const open = calibrationReport(asOfView(series(200, 100), T0 + 500 * DAY));
  expect("200 trades opens the gate", !open.gated, `validation=${open.validationSamples}`);
  expect("...with at least the minimum in validation", open.validationSamples >= MIN_CALIBRATION_SAMPLES);
  expect("...and scores present", open.raw.brier != null && open.calibrated.brier != null && open.climatologyBrier != null);
  expect("...and the climatology comparison stated outright", typeof open.beatsClimatology === "boolean");

  // Confidence carrying no information must NOT beat predicting the base rate.
  const noise = Array.from({ length: 200 }, (_, i) => trade({
    entryTime: T0 + i * DAY, closedAt: T0 + i * DAY + HOUR,
    confidence: 50 + (i % 40),          // varies
    pnl: i % 2 === 0 ? 10 : -10,        // independently of the outcome
    exitReason: i % 2 === 0 ? "take_profit" : "stop_loss",
  }));
  const noiseReport = calibrationReport(asOfView(noise, T0 + 500 * DAY));
  expect("uninformative confidence does not beat climatology", !noiseReport.beatsClimatology,
    `calibrated=${noiseReport.calibrated.brier} climatology=${noiseReport.climatologyBrier}`);

  // Scratches are dropped, not forced to a side.
  const withScratch = toCalibrationPoints(asOfView([
    ...series(10, 5),
    ...series(10, 0, { exitReason: "break_even", pnl: 0 }),
  ], T0 + 500 * DAY));
  expect("break-even trades are excluded from the calibration set", withScratch.rows.length === 10);
  const noConfidence = toCalibrationPoints(asOfView(series(10, 5, { confidence: null }), T0 + 500 * DAY));
  expect("trades with no recorded confidence are excluded too", noConfidence.rows.length === 0);
}

// ── Similarity ──────────────────────────────────────────────────────────────
{
  const candidate = { confidence: 70, rsi: 55, adx: 25, atrPercent: 0.8, volumeRatio: 1.2, macdHistogram: 0.4 };

  const thinPool = asOfView(series(MIN_POOL_SIZE - 1, 15), T0 + 500 * DAY);
  const thin = findSimilarTrades(candidate, thinPool);
  expect("a pool too small to z-score is unavailable", !thin.available);
  expect("...with no matches at all, not a short list", thin.matches.length === 0);
  expect("...and a reason that names the shortfall", thin.reason.includes(String(MIN_POOL_SIZE)));

  // A pool of 60: half resemble the candidate, half are its opposite.
  const varied = [
    ...Array.from({ length: 30 }, (_, i) => trade({
      tradeId: 1000 + i, entryTime: T0 + i * DAY, closedAt: T0 + i * DAY + HOUR, pnl: 10,
      features: { confidence: 72 + (i % 3), rsi: 57 + (i % 3), adx: 27 + (i % 3), atrPercent: 0.85, volumeRatio: 1.25, macdHistogram: 0.45 },
    })),
    ...Array.from({ length: 30 }, (_, i) => trade({
      tradeId: 2000 + i, entryTime: T0 + (30 + i) * DAY, closedAt: T0 + (30 + i) * DAY + HOUR, pnl: -10, exitReason: "stop_loss",
      features: { confidence: 40 + (i % 3), rsi: 25 + (i % 3), adx: 12 + (i % 3), atrPercent: 2.4, volumeRatio: 0.5, macdHistogram: -0.6 },
    })),
  ];
  const pool = asOfView(varied, T0 + 500 * DAY);
  const found = findSimilarTrades(candidate, pool);

  expect("a real pool with real neighbours is available", found.available, found.reason);
  expect("...and every returned match clears the floor", found.matches.every((m) => m.similarity >= SIMILARITY_FLOOR));
  expect("...ordered most-similar first", found.matches.every((m, i, a) => i === 0 || a[i - 1]!.similarity >= m.similarity));
  expect("...drawn from the resembling half, not the opposite one",
    found.matches.every((m) => m.tradeId < 2000), `${found.matches.filter((m) => m.tradeId >= 2000).length} opposites matched`);
  expect("...capped at 50", found.matches.length <= 50);
  expect("...naming the axes it actually used", found.featuresUsed.length >= 2);

  // The top-N trap: a candidate resembling nothing must return nothing.
  const alien = { confidence: 5, rsi: 99, adx: 1, atrPercent: 12, volumeRatio: 9, macdHistogram: -20 };
  const none = findSimilarTrades(alien, pool);
  expect("a candidate resembling nothing returns nothing, not a top-N slice",
    !none.available && none.matches.length === 0, `${none.matches.length} matches`);
  expect("...and says the floor is why", none.reason.toLowerCase().includes("similarity floor"));

  // Aggregate stats are gated separately from the match list.
  const fewMatches = findSimilarTrades(candidate, pool, { minMatchesForStats: 999 });
  expect("matches can be listed while their aggregate stats stay gated",
    fewMatches.available && fewMatches.matches.length > 0 && fewMatches.stats === null);
  expect("with enough matches, stats appear", found.stats != null && found.stats.samples === found.matches.length);

  // Normalisation is what makes the comparison meaningful.
  const stats = normalisationStats(varied.map((t) => t.features!));
  expect("a constant feature is dropped — it says nothing about similarity", (() => {
    const constant = normalisationStats(varied.map(() => ({ confidence: 50, rsi: 10, adx: 5 })));
    return constant.usable.length === 0;
  })());
  expect("standardised vectors are centred near zero", (() => {
    const all = varied.map((t) => standardise(t.features!, stats));
    const mean = all[0]!.map((_, i) => all.reduce((s, v) => s + v[i]!, 0) / all.length);
    return mean.every((m) => Math.abs(m) < 1e-9);
  })());
  expect("cosine of a vector with itself is 1", Math.abs(cosine([1, 2, 3], [1, 2, 3])! - 1) < 1e-12);
  expect("cosine of opposites is −1", Math.abs(cosine([1, 2, 3], [-1, -2, -3])! + 1) < 1e-12);
  expect("cosine against the origin is undefined, not zero", cosine([0, 0], [1, 1]) === null);

  // Un-normalised, the large-magnitude axes would decide the answer. This is
  // the concrete reason standardise() exists, so it is asserted directly.
  expect("normalisation changes the ranking a raw dot product would give", (() => {
    const raw = (a: Record<string, number>, b: Record<string, number>) =>
      cosine(Object.values(a), Object.values(b))!;
    const near = varied[0]!.features!;
    const far = varied[45]!.features!;
    // Raw cosine calls the opposite setup nearly as similar as the matching one.
    const rawGap = raw(candidate, near as Record<string, number>) - raw(candidate, far as Record<string, number>);
    const zGap =
      cosine(standardise(candidate, stats), standardise(near, stats))! -
      cosine(standardise(candidate, stats), standardise(far, stats))!;
    return zGap > rawGap;
  })());

  // Point-in-time applies to the pool too.
  const early = findSimilarTrades(candidate, asOfView(varied, T0 + 10 * DAY));
  // Trades 0..9 have settled by then (each closes an hour after its day mark).
  expect("the similarity pool respects the as-of cut", !early.available && early.poolSize === 10, String(early.poolSize));

  // Trades with no captured features count in cells but not in the pool.
  const featureless = varied.map((t) => ({ ...t, features: null }));
  expect("trades without recorded indicators are excluded from the pool",
    findSimilarTrades(candidate, asOfView(featureless, T0 + 500 * DAY)).poolSize === 0);
  expect("...while still counting toward the cells",
    buildKnowledge(asOfView(featureless, T0 + 500 * DAY)).totalTrades === 60);
}

console.log(failures === 0 ? "\nknowledge: all checks passed" : `\nknowledge: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
