/**
 * MEMORY INFLUENCE test — the only phase that can change what the engine does
 * with real money, so the assertions are about what it CANNOT do.
 *
 * Five properties, each defending a way this feature turns into a loss:
 *
 *   NO-OP AT ZERO   influence off, or on with no qualifying cell, must leave
 *                   every plan admitted. If this fails, shipping P8 silently
 *                   changes every existing account's behaviour.
 *   TIGHTEN ONLY    memory must never lower a bar or originate a plan. A
 *                   sign error here turns a filter into a trade generator.
 *   EVIDENCE ONLY   a thin cell, or one BH calls noise, must contribute
 *                   nothing — otherwise this is the multiple-comparisons trap
 *                   with money attached.
 *   BOUNDED         no stack of dimensions may reach past the configured cap.
 *   HONEST PROOF    walk-forward validation must fit on train, test on
 *                   validation, and return `no_better` when it is no better.
 *
 * Pure — no DB, no exchange, no clock.
 *
 * Run:  tsx harness/memory-influence.test.ts   (exit 0 = pass)
 */
import { asOfView } from "../src/lib/knowledge/pointInTime";
import { buildKnowledge, type TradeObservation } from "../src/lib/knowledge/cells";
import {
  buildInfluenceState, evaluateInfluence, deltaForCell, hashRules, summariseState,
  INERT_STATE, DEFAULT_MAX_DELTA, SATURATION_GAP, MIN_APPLIED_DELTA,
  type InfluenceCandidate, type InfluenceState,
} from "../src/lib/memory/influence";
import {
  validateInfluence, MIN_VALIDATION_TRADES, MIN_SURVIVING_FRACTION,
} from "../src/lib/memory/validation";

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
const T0 = Date.parse("2025-01-06T09:00:00Z");

function trade(over: Partial<TradeObservation> = {}): TradeObservation {
  const entryTime = over.entryTime ?? T0;
  return {
    tradeId: 0, entryTime, closedAt: entryTime + HOUR,
    symbol: "BTCUSDT", strategyId: "momentum", regime: "trending_up",
    atrPercent: 0.8, pnl: 10, plannedRisk: 10, exitReason: "take_profit",
    confidence: 70, features: null,
    ...over,
  };
}

/** n trades, `wins` of which made money, one per day from `startDay`. */
function series(n: number, wins: number, over: Partial<TradeObservation> = {}, startDay = 0): TradeObservation[] {
  return Array.from({ length: n }, (_, i) => {
    const entryTime = T0 + (startDay + i) * DAY;
    return trade({
      entryTime, closedAt: entryTime + HOUR,
      pnl: i < wins ? 10 : -10,
      exitReason: i < wins ? "take_profit" : "stop_loss",
      ...over,
    });
  });
}

function candidate(over: Partial<InfluenceCandidate> = {}): InfluenceCandidate {
  return {
    strategyId: "momentum", symbol: "BTCUSDT", regime: "trending_up",
    entryTime: T0, atrPercent: 0.8, confidence: 70, strategyThreshold: 65,
    ...over,
  };
}

/**
 * A record where ETH·momentum is genuinely and significantly worse than the
 * account baseline — the shape memory is supposed to notice.
 */
function recordWithDragCell(): TradeObservation[] {
  return [
    ...series(60, 54, { symbol: "BTCUSDT" }, 0),    // 90%
    ...series(60, 18, { symbol: "ETHUSDT" }, 100),  // 30%
  ];
}

function stateFrom(rows: TradeObservation[], opts: { maxDelta?: number; enabled?: boolean } = {}): InfluenceState {
  const report = buildKnowledge(asOfView(rows, T0 + 1000 * DAY));
  return buildInfluenceState(report, { enabled: opts.enabled ?? true, maxDelta: opts.maxDelta, now: T0 });
}

// ── The no-op guarantee ─────────────────────────────────────────────────────
{
  const out = evaluateInfluence(INERT_STATE, candidate());
  expect("the inert state changes nothing", !out.applied && out.admitted && out.delta === 0);
  expect("...and reports the plan's own reference bar", out.requiredConfidence === out.reference);

  // The dangerous case: a plan whose blended confidence sits BELOW its own
  // strategy's configured threshold. Confidence unification does not re-gate
  // (strategies/selector.ts), so these plans legitimately exist — and a naive
  // `confidence >= threshold + delta` would reject every one of them the
  // moment P8 shipped, with the feature switched off.
  const belowOwnBar = evaluateInfluence(INERT_STATE, candidate({ confidence: 40, strategyThreshold: 65 }));
  expect("a plan below its own strategy's threshold is still admitted when inert", belowOwnBar.admitted);

  const disabled = stateFrom(recordWithDragCell(), { enabled: false });
  expect("a state with rules but disabled has rules", disabled.rules.length > 0);
  expect("...and still admits everything", (() => {
    const c = candidate({ symbol: "ETHUSDT", confidence: 40, strategyThreshold: 65 });
    const o = evaluateInfluence(disabled, c);
    return !o.applied && o.admitted && o.delta === 0;
  })());

  // Exhaustive: across a grid of plans, an inert state must never withhold.
  let withheld = 0;
  for (let conf = 0; conf <= 100; conf += 5) {
    for (const threshold of [0, 40, 55, 65, 80, 100]) {
      for (const symbol of ["BTCUSDT", "ETHUSDT", "SOLUSDT"]) {
        const o = evaluateInfluence(INERT_STATE, candidate({ confidence: conf, strategyThreshold: threshold, symbol }));
        if (!o.admitted) withheld++;
      }
    }
  }
  expect("no plan in a 378-case grid is withheld by the inert state", withheld === 0, `${withheld} withheld`);
}

// ── Tightening only ─────────────────────────────────────────────────────────
{
  expect("a cell at the baseline produces no delta", deltaForCell(0.5, 0.5, 10) === 0);
  expect("a cell ABOVE the baseline produces no delta — memory never loosens",
    deltaForCell(0.9, 0.5, 10) === 0);
  expect("a cell below the baseline produces a positive delta", deltaForCell(0.4, 0.5, 10) > 0);
  expect("the delta saturates at the configured gap",
    deltaForCell(0.5 - SATURATION_GAP, 0.5, 10) === 10 && deltaForCell(0.0, 0.5, 10) === 10);
  expect("the delta is linear below saturation",
    Math.abs(deltaForCell(0.5 - SATURATION_GAP / 2, 0.5, 10) - 5) < 1e-9);

  const state = stateFrom(recordWithDragCell());
  expect("only losing cells become rules", state.rules.every((r) => r.winRate < r.baselineWinRate));
  expect("every rule's delta is positive", state.rules.every((r) => r.delta > 0));
  expect("the winning symbol never becomes a rule", !state.rules.some((r) => r.key.startsWith("BTCUSDT")));
  expect("the losing symbol does", state.rules.some((r) => r.key.startsWith("ETHUSDT")), state.rules.map((r) => r.key).join(","));

  // The bar only ever moves up, so a plan admitted with memory would always
  // have been admitted without it. Checked directly rather than reasoned about.
  let loosened = 0;
  for (let conf = 0; conf <= 100; conf += 2) {
    const c = candidate({ symbol: "ETHUSDT", confidence: conf });
    const on = evaluateInfluence(state, c);
    const off = evaluateInfluence({ ...state, enabled: false }, c);
    if (on.admitted && !off.admitted) loosened++;
    if (on.requiredConfidence < off.requiredConfidence) loosened++;
  }
  expect("memory never admits a plan the engine would have refused", loosened === 0, `${loosened} loosenings`);
}

// ── Evidence gates ──────────────────────────────────────────────────────────
{
  // A 5-for-0 losing streak is not evidence. It must not become a rule.
  const thin = stateFrom([...series(60, 42, { symbol: "BTCUSDT" }), ...series(5, 0, { symbol: "SOLUSDT" }, 100)]);
  expect("a 5-trade losing cell produces no rule", !thin.rules.some((r) => r.key.includes("SOLUSDT")),
    thin.rules.map((r) => r.key).join(","));

  // An ungated cell that BH does not call significant must also contribute
  // nothing — the gate and the correction are two separate hurdles.
  const mild = stateFrom([...series(60, 33, { symbol: "BTCUSDT" }), ...series(60, 30, { symbol: "ETHUSDT" }, 100)]);
  expect("a cell within noise of the baseline produces no rule", mild.rules.length === 0,
    mild.rules.map((r) => `${r.key}@q${r.qValue}`).join(","));

  const noBaseline = stateFrom(series(10, 3));
  expect("with no trustworthy baseline there are no rules", noBaseline.rules.length === 0);
  expect("...and the state is the inert version", noBaseline.version === INERT_STATE.version);

  const state = stateFrom(recordWithDragCell());
  expect("every rule cleared the sample gate", state.rules.every((r) => r.samples >= 30));
  expect("every rule survived the correction", state.rules.every((r) => r.qValue <= 0.1));
  expect("sub-point deltas are dropped as noise", (() => {
    const tiny = stateFrom(recordWithDragCell(), { maxDelta: 0.5 });
    return tiny.rules.every((r) => r.delta >= MIN_APPLIED_DELTA) && tiny.rules.length === 0;
  })());
}

// ── Bounding ────────────────────────────────────────────────────────────────
{
  // A candidate matching every dimension at once: the stack test.
  const rows = [
    ...series(60, 54, { symbol: "BTCUSDT", strategyId: "momentum", regime: "trending_up", atrPercent: 0.8 }, 0),
    ...series(90, 18, {
      symbol: "ETHUSDT", strategyId: "reversion", regime: "ranging", atrPercent: 2.5,
      entryTime: T0 + 100 * DAY,
    }, 100),
  ].map((t, i) => ({ ...t, entryTime: t.entryTime, closedAt: T0 + i * DAY + HOUR }));

  const state = stateFrom(rows, { maxDelta: 6 });
  const stacked = evaluateInfluence(state, candidate({
    symbol: "ETHUSDT", strategyId: "reversion", regime: "ranging", atrPercent: 2.5,
    confidence: 100, strategyThreshold: 65,
  }));

  if (stacked.applied) {
    expect("several dimensions can match one candidate", stacked.rules.length >= 2, `${stacked.rules.length} matched`);
    expect("the summed delta is clamped to the cap", stacked.delta <= 6 + 1e-9, String(stacked.delta));
    expect("...even though the raw sum exceeds it",
      stacked.rules.reduce((s, r) => s + r.delta, 0) > 6,
      String(stacked.rules.reduce((s, r) => s + r.delta, 0)));
  } else {
    expect("the stack test produced matching rules", false, "no rules matched — fixture no longer exercises the clamp");
  }

  const capped = stateFrom(recordWithDragCell(), { maxDelta: 3 });
  expect("no rule exceeds the cap on its own", capped.rules.every((r) => r.delta <= 3 + 1e-9));
  expect("a lower cap yields a different version", capped.version !== stateFrom(recordWithDragCell()).version);
}

// ── Versioning ──────────────────────────────────────────────────────────────
{
  const a = stateFrom(recordWithDragCell(), { maxDelta: 10 });
  const b = stateFrom(recordWithDragCell(), { maxDelta: 10 });
  expect("the same rules hash to the same version", a.version === b.version, `${a.version} vs ${b.version}`);
  expect("...regardless of when they were built",
    hashRules(a.rules, a.maxDelta) === hashRules([...b.rules].reverse(), b.maxDelta));
  expect("the cap is part of the identity",
    hashRules(a.rules, 10) !== hashRules(a.rules, 5));
  expect("a state with rules is not memory-0", a.version.startsWith("memory-1:"));
  expect("an empty state is memory-0", stateFrom(series(40, 20)).version === "memory-0");
  expect("the summary says memory can only withhold", summariseState(a).includes("only withhold"));
  expect("an empty state's summary says it would change nothing",
    summariseState(INERT_STATE).includes("change nothing"));
}

// ── Admission arithmetic ────────────────────────────────────────────────────
{
  const state = stateFrom(recordWithDragCell());
  const rule = state.rules.find((r) => r.key === "ETHUSDT|momentum");
  expect("the drag cell is a rule", rule != null, state.rules.map((r) => r.key).join(","));

  if (rule) {
    // Reference = min(threshold, confidence). A plan comfortably above its
    // bar survives a small raise; one sitting on its bar does not.
    const comfortable = evaluateInfluence(state, candidate({ symbol: "ETHUSDT", confidence: 95, strategyThreshold: 65 }));
    expect("a plan far above its bar clears the raised one", comfortable.admitted, comfortable.reason);
    expect("...and the raise is recorded even though it passed", comfortable.applied);

    const marginal = evaluateInfluence(state, candidate({ symbol: "ETHUSDT", confidence: 65, strategyThreshold: 65 }));
    expect("a plan sitting exactly on its bar is withheld", !marginal.admitted, marginal.reason);
    expect("...and the refusal explains itself with the evidence",
      marginal.reason.includes("%") && marginal.reason.includes("over"));

    expect("the required bar is reference + delta",
      Math.abs(marginal.requiredConfidence - (65 + marginal.delta)) < 1e-9);
    // Sweeping confidence upward, admission must switch on once and stay on.
    // A non-monotone gate would mean a BETTER plan could be withheld where a
    // worse one passed — indefensible to a user and a sign of a sign error.
    expect("admission is monotone in confidence", (() => {
      let admittedAt: number | null = null;
      for (let conf = 0; conf <= 100; conf += 1) {
        const o = evaluateInfluence(state, candidate({ symbol: "ETHUSDT", confidence: conf, strategyThreshold: 65 }));
        if (o.admitted && admittedAt == null) admittedAt = conf;
        if (!o.admitted && admittedAt != null) return false; // switched back off
      }
      return admittedAt != null;
    })());

    // A different symbol is untouched by an ETH-keyed rule.
    const other = evaluateInfluence(state, candidate({ symbol: "SOLUSDT", confidence: 65, strategyThreshold: 65 }));
    expect("a symbol with no rule is unaffected", other.admitted);
  }
}

// ── Walk-forward validation ─────────────────────────────────────────────────
{
  const thin = validateInfluence(asOfView(series(30, 15), T0 + 1000 * DAY));
  expect("too little out-of-sample data yields insufficient_data", thin.verdict === "insufficient_data");
  expect("...and says how many more are needed", thin.summary.includes(String(MIN_VALIDATION_TRADES)));

  // A record where one symbol loses consistently across BOTH windows: the
  // case where memory genuinely should help out-of-sample. Interleaved so
  // both symbols appear in train and validation alike.
  const interleaved: TradeObservation[] = [];
  for (let i = 0; i < 200; i++) {
    const eth = i % 2 === 1;
    const win = eth ? i % 10 === 1 : i % 10 !== 1; // ETH ~20%, BTC ~90%
    const entryTime = T0 + i * DAY;
    interleaved.push(trade({
      entryTime, closedAt: entryTime + HOUR,
      symbol: eth ? "ETHUSDT" : "BTCUSDT",
      confidence: 66,
      pnl: win ? 10 : -10,
      exitReason: win ? "take_profit" : "stop_loss",
    }));
  }
  const good = validateInfluence(asOfView(interleaved, T0 + 1000 * DAY), { defaultThreshold: 65 });
  expect("a genuine, persistent drag cell is found out-of-sample", good.verdict === "improved",
    `${good.verdict}: ${good.summary}`);
  expect("...the withheld trades lost money", good.withheldPnlUsdt < 0, String(good.withheldPnlUsdt));
  expect("...expectancy improved", good.expectancyDelta > 0, String(good.expectancyDelta));
  expect("...on trades the fit never saw", good.validationTrades > 0 && good.trainTrades > 0);
  expect("...and the approved state is returned with the verdict", good.state.rules.length > 0);
  expect("...and the baseline arm saw every validation trade",
    good.baseline.trades === good.validationTrades);
  expect("...while the memory arm saw fewer",
    good.withMemory.trades === good.validationTrades - good.withheld);

  // Noise: no symbol is genuinely worse, so there is nothing to find.
  const noise: TradeObservation[] = [];
  for (let i = 0; i < 200; i++) {
    const entryTime = T0 + i * DAY;
    noise.push(trade({
      entryTime, closedAt: entryTime + HOUR,
      symbol: i % 2 === 0 ? "BTCUSDT" : "ETHUSDT",
      confidence: 66,
      pnl: i % 3 === 0 ? -10 : 10,
      exitReason: i % 3 === 0 ? "stop_loss" : "take_profit",
    }));
  }
  const nothing = validateInfluence(asOfView(noise, T0 + 1000 * DAY), { defaultThreshold: 65 });
  expect("a record with no real edge returns no_better", nothing.verdict === "no_better",
    `${nothing.verdict}: ${nothing.summary}`);
  expect("...and says so plainly", nothing.summary.length > 20);

  // The over-fitting shape: rules that withhold most of the flow are refused
  // even if expectancy on what remains looks better.
  const brutal = validateInfluence(asOfView(interleaved, T0 + 1000 * DAY), {
    defaultThreshold: 100, // every plan sits on its bar ⇒ any delta withholds
    maxDelta: 25,
  });
  expect("a rule set that withholds most of the account is refused",
    brutal.verdict === "no_better" || brutal.withheld / brutal.validationTrades <= 1 - MIN_SURVIVING_FRACTION,
    `${brutal.verdict}, withheld ${brutal.withheld}/${brutal.validationTrades}`);

  expect("the default cap is what the validation used when unspecified",
    good.state.maxDelta === DEFAULT_MAX_DELTA);
}

console.log(failures === 0 ? "\nmemory-influence: all checks passed" : `\nmemory-influence: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
