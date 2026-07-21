/**
 * Offline verification for the Custom Strategy Builder (Phase 1):
 *  - zod rule-document validation (bounds, unknown indicators, side rules)
 *  - the interpreter's condition truth table (numeric / enum / bool / derived)
 *  - stop-placement math for all 3 modes (atr / percent / swing)
 *  - decide() gating (no-match → null, contradiction → null, dollar plan
 *    required, full pipeline produces a plan)
 *  - selector injection via extraStrategies (config gate respected; absent
 *    param = byte-identical built-in behavior)
 *  - built-in catalog shape UNCHANGED (customs never enter ALL_STRATEGIES)
 *
 * Run:  tsx harness/custom-strategy.test.ts   (exit 0 = all pass)
 */
import { parseCustomRules, describeRules, type CustomRules } from "../src/lib/customRules";
import { CustomStrategy, indicatorValue, evalCondition, DEFAULT_CUSTOM_STRATEGY_CONFIG } from "../src/lib/strategies/custom";
import {
  strategySelector, ALL_STRATEGIES, CRYPTO_STRATEGIES, FOREX_STRATEGIES,
  type StrategyConfig,
} from "../src/lib/strategies";

let failures = 0;
function expect(name: string, actual: unknown, wanted: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(wanted);
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗ FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(actual)}, wanted ${JSON.stringify(wanted)})`}`);
}
function expectThrows(name: string, fn: () => unknown) {
  try { fn(); failures++; console.log(`✗ FAIL  ${name}  (expected a validation error, none thrown)`); }
  catch { console.log(`✓  ${name}`); }
}

// ── Shared fixtures ─────────────────────────────────────────────────────────
// 2026-07-15 14:30 UTC — the newest 1m candle pins hourUtc to 14.
const NOW = Date.UTC(2026, 6, 15, 14, 30);
const M1 = 60_000, M15 = 15 * 60_000;

function mkMtf(opts?: { fifteenLow?: number; fifteenHigh?: number }) {
  const lo = opts?.fifteenLow ?? 9900;
  const hi = opts?.fifteenHigh ?? 9990;
  const tf1m: number[][] = [];
  for (let i = 239; i >= 0; i--) tf1m.push([NOW - i * M1, 10000, 10006, 9994, 10000, 100]);
  const tf5m: number[][] = [];
  for (let i = 59; i >= 0; i--) tf5m.push([NOW - i * 5 * M1, 10000, 10010, 9990, 10000, 400]);
  const tf15m: number[][] = [];
  for (let i = 39; i >= 0; i--) tf15m.push([NOW - i * M15, (lo + hi) / 2, hi, lo, (lo + hi) / 2, 900]);
  return { tf1m, tf3m: tf5m, tf5m, tf15m, tf1h: tf15m } as any;
}

function mkRow(overrides: Record<string, unknown> = {}) {
  return {
    symbol: "BTC/USDT", confidence: 80, shortConfidence: 20,
    rsi: 25, atrPercent: 0.5, atrAbs: 50, ema5AboveEma20: true,
    macroBullish: true, macroBearish: false, volumeRatio: 1.5,
    lastPrice: 10000, regime: "range", adx: 20, macdHistogram: 5,
    candleMinutes: 1, votes: [],
    ...overrides,
  } as any;
}

const BASE_RULES: CustomRules = parseCustomRules({
  long: [{ indicator: "rsi", op: "lt", value: 30 }],
  stop: { mode: "percent", pct: 1.0 },
  confidence: 70,
});

function mkConfig(overrides: Partial<StrategyConfig> = {}): StrategyConfig {
  return {
    strategyId: "custom_1",
    ...DEFAULT_CUSTOM_STRATEGY_CONFIG,
    enabled: true,
    tradeAmountUsdt: 1000, maxLossUsdt: 12, targetProfitUsdt: 15,
    confidenceThreshold: 60,
    ...overrides,
  };
}

const DOLLAR_RISK = {
  marketType: "spot" as const, leverage: 1,
  feeRate: 0.0001, slippageRate: 0.00005,
  globalTradeAmountUsdt: 1000,
};

function decideDirect(rules: CustomRules, row = mkRow(), mtf = mkMtf(), config = mkConfig()) {
  const strat = new CustomStrategy("custom_1", "Test Strategy", rules);
  const ctx = {
    balance: 100000, positionSizeUsdt: 1000, marketType: "spot", leverageCap: 1,
    feeRate: 0.0001, slippageRate: 0.00005,
    dollarPlan: config.tradeAmountUsdt != null
      ? { tradeAmountUsdt: config.tradeAmountUsdt, maxLossUsdt: config.maxLossUsdt, targetProfitUsdt: config.targetProfitUsdt }
      : undefined,
  } as any;
  return strat.decide("BTC/USDT", mtf, row, config, ctx);
}

// ── 1. zod validation ───────────────────────────────────────────────────────
expect("valid rules parse", BASE_RULES.long!.length, 1);
expectThrows("rsi 150 out of bounds rejected", () =>
  parseCustomRules({ long: [{ indicator: "rsi", op: "lt", value: 150 }], stop: { mode: "atr", atrMult: 2 }, confidence: 70 }));
expectThrows("unknown indicator rejected", () =>
  parseCustomRules({ long: [{ indicator: "bollinger", op: "lt", value: 1 }], stop: { mode: "atr", atrMult: 2 }, confidence: 70 }));
expectThrows("bad regime value rejected", () =>
  parseCustomRules({ long: [{ indicator: "regime", op: "eq", value: "sideways" }], stop: { mode: "atr", atrMult: 2 }, confidence: 70 }));
expectThrows("no sides rejected", () =>
  parseCustomRules({ stop: { mode: "atr", atrMult: 2 }, confidence: 70 }));
expectThrows("9 conditions on one side rejected", () =>
  parseCustomRules({ long: Array(9).fill({ indicator: "rsi", op: "lt", value: 30 }), stop: { mode: "atr", atrMult: 2 }, confidence: 70 }));
expectThrows("swing lookback 2 rejected", () =>
  parseCustomRules({ long: [{ indicator: "rsi", op: "lt", value: 30 }], stop: { mode: "swing", lookback: 2 }, confidence: 70 }));
expectThrows("confidence 40 rejected", () =>
  parseCustomRules({ long: [{ indicator: "rsi", op: "lt", value: 30 }], stop: { mode: "atr", atrMult: 2 }, confidence: 40 }));
expectThrows("numeric op on enum indicator rejected", () =>
  parseCustomRules({ long: [{ indicator: "regime", op: "gt", value: "range" }], stop: { mode: "atr", atrMult: 2 }, confidence: 70 }));

// ── 2. Indicator resolution + condition truth table ─────────────────────────
const row = mkRow(), mtf = mkMtf();
expect("rsi resolves", indicatorValue("rsi", row, mtf), 25);
expect("hourUtc from newest 1m candle (not wall clock)", indicatorValue("hourUtc", row, mtf), 14);
expect("ema20AboveEma50 maps to the misnamed row field", indicatorValue("ema20AboveEma50", row, mtf), "true");
expect("macroBullish stringified", indicatorValue("macroBullish", row, mtf), "true");
expect("regime passes through", indicatorValue("regime", row, mtf), "range");
// 15m window: high 9990, low 9900, price 10000 → 0% below high (clamped), ~1.01% above low.
expect("pctFromHigh20 clamps at 0 above the high", indicatorValue("pctFromHigh20", row, mtf), 0);
const pctLow = indicatorValue("pctFromLow20", row, mtf) as number;
expect("pctFromLow20 ≈ 1.0101%", Math.abs(pctLow - ((10000 - 9900) / 9900) * 100) < 1e-9, true);

expect("gt strict", evalCondition({ indicator: "rsi", op: "gt", value: 25 } as any, row, mtf).pass, false);
expect("gte inclusive", evalCondition({ indicator: "rsi", op: "gte", value: 25 } as any, row, mtf).pass, true);
expect("lt strict", evalCondition({ indicator: "rsi", op: "lt", value: 25 } as any, row, mtf).pass, false);
expect("lte inclusive", evalCondition({ indicator: "rsi", op: "lte", value: 25 } as any, row, mtf).pass, true);
expect("enum eq match", evalCondition({ indicator: "regime", op: "eq", value: "range" } as any, row, mtf).pass, true);
expect("enum eq mismatch", evalCondition({ indicator: "regime", op: "eq", value: "strong_trend" } as any, row, mtf).pass, false);
expect("bool eq false mismatch", evalCondition({ indicator: "macroBearish", op: "eq", value: "true" } as any, row, mtf).pass, false);

// ── 3. decide() gating ──────────────────────────────────────────────────────
// Conditions not met → null (silent, like a built-in with no setup).
expect("no-match → null", decideDirect(BASE_RULES, mkRow({ rsi: 55 })), null);

// Contradiction: both sides fire on the same bar → null.
const contradictory = parseCustomRules({
  long: [{ indicator: "confidence", op: "gte", value: 0 }],
  short: [{ indicator: "confidence", op: "gte", value: 0 }],
  stop: { mode: "percent", pct: 1.0 }, confidence: 70,
});
expect("both sides firing → null", decideDirect(contradictory), null);

// Dollar plan required.
const noPlan = decideDirect(BASE_RULES, mkRow(), mkMtf(), mkConfig({ tradeAmountUsdt: null, maxLossUsdt: null, targetProfitUsdt: null }));
expect("no dollar plan → rejection", (noPlan as any)?.kind, "rejection");
expect("…at the dollar-plan stage", (noPlan as any)?.rejection?.stage, "dollar-plan");

// Full pipeline → a plan with the rule-derived stop.
const planDecision = decideDirect(BASE_RULES) as any;
expect("full pipeline produces a plan", planDecision?.kind, "plan");
if (planDecision?.kind === "plan") {
  const p = planDecision.plan;
  expect("plan side long", p.side, "long");
  expect("plan confidence = static rule confidence", p.confidence, 70);
  expect("percent stop ≈ 1% below entry", Math.abs(p.slPrice - 10000 * 0.99) < 10000 * 0.002, true);
  expect("report lists each condition as a check", p.report.checks.some((c: any) => c.name.includes("RSI")), true);
} else {
  console.log(`   (rejection detail: ${JSON.stringify((planDecision as any)?.rejection ?? planDecision)})`);
}

// ATR stop: 2 × atrAbs(50) = 100 below entry for longs.
const atrRules = parseCustomRules({
  long: [{ indicator: "rsi", op: "lt", value: 30 }],
  stop: { mode: "atr", atrMult: 2 }, confidence: 70,
});
const atrDecision = decideDirect(atrRules) as any;
if (atrDecision?.kind === "plan") {
  expect("atr stop ≈ entry − 2×ATR", Math.abs(atrDecision.plan.slPrice - (10000 - 100)) < 10000 * 0.002, true);
} else {
  expect("atr-stop pipeline produces a plan", atrDecision?.kind, "plan");
}

// Swing stop: min 15m low (9900) is the level for longs.
const swingRules = parseCustomRules({
  long: [{ indicator: "rsi", op: "lt", value: 30 }],
  stop: { mode: "swing", lookback: 20 }, confidence: 70,
});
const swingDecision = decideDirect(swingRules) as any;
if (swingDecision?.kind === "plan") {
  expect("swing stop at the 20-bar 15m low", Math.abs(swingDecision.plan.slPrice - 9900) < 10000 * 0.002, true);
} else {
  expect("swing-stop pipeline produces a plan", swingDecision?.kind, "plan");
}

// Swing level on the wrong side of price (price already below it) → setup rejection.
const swingWrong = decideDirect(swingRules, mkRow({ lastPrice: 9800 })) as any;
expect("wrong-side swing level → rejection", swingWrong?.kind, "rejection");
expect("…at the setup stage", swingWrong?.rejection?.stage, "setup");

// Short side works symmetrically.
const shortRules = parseCustomRules({
  short: [{ indicator: "rsi", op: "gt", value: 70 }],
  stop: { mode: "percent", pct: 1.0 }, confidence: 70,
});
const shortDecision = decideDirect(shortRules, mkRow({ rsi: 80 })) as any;
expect("short rules produce a short decision", shortDecision != null, true);
if (shortDecision?.kind === "plan") {
  expect("short plan side", shortDecision.plan.side, "short");
  expect("short stop above entry", shortDecision.plan.slPrice > 10000, true);
}

// ── 4. Selector injection (extraStrategies) ─────────────────────────────────
const customStrat = new CustomStrategy("custom_1", "Test Strategy", BASE_RULES);
const configs = new Map<string, StrategyConfig>([["custom_1", mkConfig()]]);

// Without extraStrategies: no built-in has a config entry → nothing happens.
const without = strategySelector.decideSymbol("BTC/USDT", mkMtf(), mkRow(), configs, 100000, 1000, DOLLAR_RISK);
expect("absent extraStrategies → no plans", without.plans.length, 0);
expect("absent extraStrategies → no rejections", without.rejections.length, 0);

// With the custom injected: it decides under the identical gates.
const withCustom = strategySelector.decideSymbol("BTC/USDT", mkMtf(), mkRow(), configs, 100000, 1000, DOLLAR_RISK, [customStrat]);
expect("injected custom produces exactly one plan", withCustom.plans.length, 1);
expect("…attributed to the custom id", withCustom.plans[0]?.strategyId, "custom_1");

// Config-disabled custom is skipped (same gate as built-ins).
const disabledConfigs = new Map<string, StrategyConfig>([["custom_1", mkConfig({ enabled: false })]]);
const disabled = strategySelector.decideSymbol("BTC/USDT", mkMtf(), mkRow(), disabledConfigs, 100000, 1000, DOLLAR_RISK, [customStrat]);
expect("disabled config → custom skipped", disabled.plans.length + disabled.rejections.length, 0);

// Custom with NO config row at all is skipped.
const noConfig = strategySelector.decideSymbol("BTC/USDT", mkMtf(), mkRow(), new Map(), 100000, 1000, DOLLAR_RISK, [customStrat]);
expect("missing config → custom skipped", noConfig.plans.length + noConfig.rejections.length, 0);

// ── 5. Built-in catalog shape unchanged ─────────────────────────────────────
expect("ALL_STRATEGIES still 9", ALL_STRATEGIES.length, 9);
expect("crypto catalog still 8", CRYPTO_STRATEGIES.length, 8);
expect("forex catalog still 6", FOREX_STRATEGIES.length, 6);
expect("no custom ids leaked into the shared roster", ALL_STRATEGIES.some((s) => s.strategyId.startsWith("custom_")), false);

// Default custom config is conservative: disabled, no dollar plan.
expect("default custom config is disabled", DEFAULT_CUSTOM_STRATEGY_CONFIG.enabled, false);
expect("default custom config has no dollar plan", DEFAULT_CUSTOM_STRATEGY_CONFIG.maxLossUsdt, null);

// Human-readable rendering exists for the UI.
expect("describeRules renders LONG sentence", describeRules(BASE_RULES)[0]?.startsWith("LONG when"), true);

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll Custom Strategy checks passed.");
