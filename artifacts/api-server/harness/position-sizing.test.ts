/**
 * Offline verification for the money-path sizing + cost math:
 *   - computeQty (strategies/base.ts): position sizing from risk params.
 *   - minViableTakeProfitPercent / netRewardRisk (tradingCosts.ts).
 *
 * A sizing bug is catastrophic (it sets the real dollar risk of every live
 * trade), so these assert the exact invariants: dollar risk == intended risk,
 * the USDT hard cap only ever REDUCES risk, invalid stops size to zero, and the
 * short side mirrors the long side.
 *
 * Run:  tsx harness/position-sizing.test.ts   (exit 0 = all pass)
 */
import { computeQty } from "../src/lib/strategies/base";
import {
  minViableTakeProfitPercent,
  netRewardRisk,
  DEFAULT_FEE_RATE,
  DEFAULT_SLIPPAGE_RATE,
} from "../src/lib/tradingCosts";

let failures = 0;
function expect(name: string, actual: unknown, wanted: unknown) {
  const ok = actual === wanted
    || (typeof wanted === "number" && typeof actual === "number" && Math.abs(actual - wanted) < 1e-9);
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗ FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(actual)}, wanted ${JSON.stringify(wanted)})`}`);
}
function approx(name: string, actual: number, wanted: number, tol = 1e-6) {
  const ok = Math.abs(actual - wanted) <= tol;
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗ FAIL"}  ${name}${ok ? "" : `  (got ${actual}, wanted ~${wanted})`}`);
}

// ── Invalid-stop guards → size 0 (reject the signal) ─────────────────────────
expect("SL <= 0 → 0", computeQty(1000, 1, 100, 0, 1000, 10, "long"), 0);
expect("long SL at entry → 0", computeQty(1000, 1, 100, 100, 1000, 10, "long"), 0);
expect("long SL above entry → 0", computeQty(1000, 1, 100, 101, 1000, 10, "long"), 0);
expect("short SL at entry → 0", computeQty(1000, 1, 100, 100, 1000, 10, "short"), 0);
expect("short SL below entry → 0", computeQty(1000, 1, 100, 99, 1000, 10, "short"), 0);

// ── Risk-based sizing: dollar risk must equal the intended risk amount ────────
{
  // balance 1000 × 1% = $10 risk; entry 100, SL 98 → stop distance 2 → qty 5.
  const qty = computeQty(1000, 1, 100, 98, 1000, 10, "long");
  approx("long risk-based qty", qty, 5);
  approx("long realized $risk == 1% of balance", qty * (100 - 98), 10);
}
{
  // Short mirror: entry 100, SL 102 → stop distance 2 → same qty 5.
  const qty = computeQty(1000, 1, 100, 102, 1000, 10, "short");
  approx("short risk-based qty", qty, 5);
  approx("short realized $risk == 1% of balance", qty * (102 - 100), 10);
}

// ── USDT hard cap only ever REDUCES risk, never increases it ─────────────────
{
  // Same setup but positionSizeUsdt caps notional at $100 → qty 1, risk $2 (< $10).
  const qty = computeQty(1000, 1, 100, 98, 100, 10, "long");
  approx("capped qty", qty, 1);
  const risk = qty * (100 - 98);
  if (risk > 10 + 1e-9) { failures++; console.log(`✗ FAIL  cap increased risk (${risk} > 10)`); }
  else console.log(`✓  cap reduces risk to $${risk} (≤ intended $10)`);
}

// ── Below-minimum-notional → 0 (don't place a dust order) ────────────────────
expect("below min notional → 0", computeQty(100, 1, 100, 98, 5, 10, "long"), 0);

// ── Fixed-size fallback (riskPercent = 0) ────────────────────────────────────
approx("fixed-size qty", computeQty(1000, 0, 100, 98, 500, 10, "long"), 5);
expect("fixed-size below min notional → 0", computeQty(1000, 0, 100, 98, 5, 10, "long"), 0);

// ── Trading-cost math ────────────────────────────────────────────────────────
approx("minViableTP spot (0.1% fee)", minViableTakeProfitPercent(0.001, 0.0005), 0.3);
approx("minViableTP futures (0.05% fee)", minViableTakeProfitPercent(0.0005, 0.0005), 0.2);
{
  // long entry 100, SL 98 (risk 2), TP 106 (reward 6); cost = 100×(2·fee+2·slip).
  const cost = 100 * (2 * DEFAULT_FEE_RATE + 2 * DEFAULT_SLIPPAGE_RATE);
  const expected = (6 - cost) / (2 + cost);
  approx("netRewardRisk after costs", netRewardRisk(100, 98, 106, "long"), expected);
}
expect("netRewardRisk invalid trade → 0", netRewardRisk(100, 102, 106, "long"), 0);

console.log(failures === 0 ? "\nAll assertions passed." : `\n${failures} assertion(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
