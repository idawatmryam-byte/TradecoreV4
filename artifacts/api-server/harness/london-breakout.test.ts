/**
 * Offline verification for the London Breakout strategy (forex-native):
 * the pure Asian-range computation, the session-window gating, and the
 * per-section catalog membership (forex gets it, crypto never does).
 *
 * Run:  tsx harness/london-breakout.test.ts   (exit 0 = all pass)
 */
import { asianRange, LondonBreakoutStrategy } from "../src/lib/strategies/london-breakout";
import { CRYPTO_STRATEGIES, FOREX_STRATEGIES, ALL_STRATEGIES, strategiesForSection, DEFAULT_STRATEGY_CONFIGS } from "../src/lib/strategies";

let failures = 0;
function expect(name: string, actual: unknown, wanted: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(wanted);
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗ FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(actual)}, wanted ${JSON.stringify(wanted)})`}`);
}

// ── Asian range: 15m candles across a UTC day ───────────────────────────────
const DAY = Date.UTC(2026, 6, 15); // Wed 2026-07-15 00:00 UTC
const M15 = 15 * 60_000;
function bar(ts: number, o: number, h: number, l: number, c: number): number[] {
  return [ts, o, h, l, c, 100];
}
// Full Asian session: 28 bars 00:00–07:00, range 1.0800–1.0840.
const asia: number[][] = [];
for (let i = 0; i < 28; i++) {
  const t = DAY + i * M15;
  asia.push(bar(t, 1.082, 1.0840 - (i % 3) * 0.0002, 1.0800 + (i % 4) * 0.0002, 1.082));
}
// A London bar after 07:00 that must NOT extend the range.
const london = [bar(DAY + 7 * 3600_000, 1.084, 1.0900, 1.0838, 1.089)];

const r = asianRange([...asia, ...london], DAY + 8 * 3600_000);
expect("range found with a full session", r != null, true);
expect("range high excludes London bars", r!.high, 1.084);
expect("range low from session lows", r!.low, 1.08);
expect("midpoint between extremes", Math.abs(r!.mid - 1.082) < 1e-9, true);
expect("width ≈ 0.37%", Math.abs(r!.widthPct - ((1.084 - 1.08) / 1.082) * 100) < 1e-9, true);

// Too few session bars → no range yet.
expect("incomplete session → null", asianRange(asia.slice(0, 10), DAY + 8 * 3600_000), null);

// ── Session-window gating: decide() passes silently outside London morning ──
const strat = new LondonBreakoutStrategy();
function decideAtHour(hourUtc: number) {
  const nowMs = DAY + hourUtc * 3600_000;
  const mtf = { tf1m: [[nowMs, 1.09, 1.09, 1.09, 1.09, 1]], tf3m: [], tf5m: [], tf15m: [...asia, ...london] } as any;
  const row = { lastPrice: 1.09, atrPercent: 0.05, volumeRatio: 1.5, regime: "weak_trend" } as any;
  const config = { ...DEFAULT_STRATEGY_CONFIGS["london_breakout"]!, strategyId: "london_breakout" } as any;
  const ctx = { balance: 100000, positionSizeUsdt: 5000, marketType: "spot", leverageCap: 1, feeRate: 0.0001, slippageRate: 0.00005, dollarPlan: { marketType: "spot", leverage: 1, feeRate: 0.0001, tradeAmountUsdt: 5000, maxLossUsdt: 10, targetProfitUsdt: 12 } } as any;
  return strat.decide("EUR_USD", mtf, row, config, ctx);
}
expect("05:00 UTC (Asia) → no decision", decideAtHour(5), null);
expect("12:00 UTC (past London morning) → no decision", decideAtHour(12), null);
const inWindow = decideAtHour(8);
expect("08:00 UTC break produces a decision (plan or reasoned rejection)", inWindow != null, true);

// A chased break (price far past the range high) must be REJECTED, not planned.
expect("extended break is a rejection", inWindow!.kind, "rejection");

// ── Catalog membership ──────────────────────────────────────────────────────
const ids = (list: Array<{ strategyId: string }>) => list.map((s) => s.strategyId);
expect("forex catalog includes london_breakout", ids(FOREX_STRATEGIES).includes("london_breakout"), true);
expect("crypto catalog EXCLUDES london_breakout", ids(CRYPTO_STRATEGIES).includes("london_breakout"), false);
expect("crypto catalog keeps its historical 8", ids(CRYPTO_STRATEGIES).length, 8);
expect("forex drops the crypto scalpers", ids(FOREX_STRATEGIES).some((id) => ["micro_scalping", "scalp_reversion", "twenty_min_momentum"].includes(id)), false);
expect("selector registry knows all 9", ids(ALL_STRATEGIES).length, 9);
expect("strategiesForSection(forex) is the forex catalog", ids(strategiesForSection("forex")), ids(FOREX_STRATEGIES));
expect("london_breakout has defaults", DEFAULT_STRATEGY_CONFIGS["london_breakout"] != null, true);

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll London Breakout checks passed.");
