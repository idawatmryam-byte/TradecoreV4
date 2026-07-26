/**
 * METRICS-KERNEL test — guards the one claim P0 makes about itself:
 * consolidating four scattered metric implementations into lib/metrics/kernel.ts
 * changed no displayed number.
 *
 * Each case below encodes the ORIGINAL formula from the call site it replaced,
 * so if someone later "simplifies" the kernel into a single win-rate function,
 * this fails and names which surface would have silently changed.
 *
 * Pure — no DB, no network.
 *
 * Run:  tsx harness/metrics-kernel.test.ts   (exit 0 = pass)
 */
import {
  classifyOutcome,
  expectancyPerDecided,
  expectancyPerTrade,
  isWin,
  maxDrawdownAbsolute,
  maxDrawdownFraction,
  plannedRiskDollars,
  profitFactor,
  PROFIT_FACTOR_NO_LOSSES,
  realizedR,
  round2,
  round4,
  round8,
  winRateOrNull,
  winRateOrZero,
} from "../src/lib/metrics/kernel";

let failures = 0;
function expect(name: string, cond: boolean, detail = "") {
  if (!cond) {
    failures++;
    console.error(`✗  ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    console.log(`✓  ${name}`);
  }
}
const eq = (a: number | null, b: number | null) =>
  a === null || b === null ? a === b : Math.abs(a - b) < 1e-12;

// ── isWin: the binary definition used by stats, backtest, demo ──────────────
expect("isWin: positive pnl wins", isWin(0.01));
expect("isWin: zero is not a win", !isWin(0));
expect("isWin: negative is not a win", !isWin(-1));
// The backtest previously partitioned with `pnl <= 0` for losses; !isWin must
// be exactly that complement or the backtest's loss set changes.
expect("isWin: !isWin(0) matches legacy `pnl <= 0`", !isWin(0) === (0 <= 0));
expect("isWin: !isWin(-2) matches legacy `pnl <= 0`", !isWin(-2) === (-2 <= 0));

// ── The two win-rate definitions differ ONLY on empty input ─────────────────
expect("winRateOrZero: 3/4", eq(winRateOrZero(3, 4), 0.75));
expect("winRateOrNull: 3/4", eq(winRateOrNull(3, 4), 0.75));
expect("winRateOrZero: empty → 0 (stats/demo/backtest render 0%)", eq(winRateOrZero(0, 0), 0));
expect("winRateOrNull: empty → null (forensics distinguish 'nothing measured')", winRateOrNull(0, 0) === null);
expect("win-rate definitions agree whenever there IS data", eq(winRateOrZero(7, 9), winRateOrNull(7, 9)));

// ── Scratch classification (Edge Forensics) ─────────────────────────────────
expect("classify: break_even exit is a scratch regardless of pnl", classifyOutcome(5, 100, "break_even") === "scratch");
expect("classify: inside ±10% of planned risk is a scratch", classifyOutcome(9, 100, "take_profit") === "scratch");
expect("classify: exactly at the 10% band is NOT a scratch", classifyOutcome(10, 100, "take_profit") === "win");
expect("classify: outside the band, positive → win", classifyOutcome(11, 100, "take_profit") === "win");
expect("classify: outside the band, negative → loss", classifyOutcome(-11, 100, "stop_loss") === "loss");
expect("classify: null planned risk falls back to sign", classifyOutcome(-0.0001, null, "stop_loss") === "loss");
expect("classify: zero pnl with no risk is a loss, not a scratch", classifyOutcome(0, null, "timeout") === "loss");

// ── Expectancy: two denominators, deliberately ──────────────────────────────
// 10 trades, 2 scratches, wins +300, losses -100.
expect("expectancyPerTrade divides by ALL trades (backtest)", eq(expectancyPerTrade(200, 10), 20));
expect("expectancyPerDecided divides by DECIDED trades (forensics)", eq(expectancyPerDecided(300, -100, 8), 25));
expect("expectancyPerTrade: empty → 0", eq(expectancyPerTrade(0, 0), 0));
expect("expectancyPerDecided: empty → null", expectancyPerDecided(0, 0, 0) === null);

// ── Profit factor, including the legacy 999 sentinel ────────────────────────
expect("profitFactor: 300/100", eq(profitFactor(300, 100), 3));
expect("profitFactor: gains but no losses → sentinel", eq(profitFactor(300, 0), PROFIT_FACTOR_NO_LOSSES));
expect("profitFactor: sentinel is still 999", PROFIT_FACTOR_NO_LOSSES === 999);
expect("profitFactor: nothing at all → 0", eq(profitFactor(0, 0), 0));

// ── Drawdown: dollars vs fraction are NOT interchangeable ───────────────────
// stats.ts semantics: cumulative pnl, peak starts at 0.
expect("maxDrawdownAbsolute: peak 50 → trough 20 is 30", eq(maxDrawdownAbsolute([50, -30]), 30));
expect("maxDrawdownAbsolute: peak starts at 0, so a losing start counts", eq(maxDrawdownAbsolute([-10, -5]), 15));
expect("maxDrawdownAbsolute: monotonic gains → 0", eq(maxDrawdownAbsolute([10, 10, 10]), 0));
expect("maxDrawdownAbsolute: empty → 0", eq(maxDrawdownAbsolute([]), 0));
// backtest semantics: equity curve, fraction of running peak.
expect("maxDrawdownFraction: 1000→800 off peak 1000 is 0.2", eq(maxDrawdownFraction([1000, 800], 1000), 0.2));
expect("maxDrawdownFraction: rising curve → 0", eq(maxDrawdownFraction([1000, 1100, 1200], 1000), 0));
expect("maxDrawdownFraction: empty falls back to startingBalance", eq(maxDrawdownFraction([], 1000), 0));
expect(
  "drawdown units are different — same data, different answers",
  !eq(maxDrawdownAbsolute([1000, -200]), maxDrawdownFraction([1000, 800], 1000))
);

// ── Planned risk & R ────────────────────────────────────────────────────────
expect("plannedRiskDollars: |100-95| × 2 = 10", eq(plannedRiskDollars(100, 95, 2), 10));
expect("plannedRiskDollars: short side is symmetric", eq(plannedRiskDollars(100, 105, 2), 10));
expect("plannedRiskDollars: zero stop distance → null", plannedRiskDollars(100, 100, 2) === null);
expect("plannedRiskDollars: zero qty → null", plannedRiskDollars(100, 95, 0) === null);
expect("realizedR: +20 on 10 risk is 2R", eq(realizedR(20, 10), 2));
expect("realizedR: -10 on 10 risk is -1R", eq(realizedR(-10, 10), -1));
expect("realizedR: unmeasurable risk → null", realizedR(20, null) === null);

// ── Rounding ────────────────────────────────────────────────────────────────
expect("round2", eq(round2(1.23456), 1.23));
expect("round4", eq(round4(0.123456), 0.1235));
expect("round8 matches the legacy 1e8 idiom", eq(round8(1.234567891), Math.round(1.234567891 * 1e8) / 1e8));

console.log(failures === 0 ? "\nAll metrics-kernel checks passed." : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
