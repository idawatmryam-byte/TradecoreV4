/**
 * Offline verification for src/lib/forexSizing.ts — the forex-specific
 * pieces layered on top of the (unchanged) dollarRisk math: pip geometry,
 * OANDA margin (marginRate × notional), the min-stop-distance guard, and
 * unit rounding.
 *
 * Run:  tsx harness/forex-sizing.test.ts   (exit 0 = all pass)
 */
import { pipSize, requiredMarginUsd, minStopDistancePrice, roundUnits } from "../src/lib/forexSizing";

let failures = 0;
function expect(name: string, actual: unknown, wanted: unknown) {
  const ok = typeof actual === "number" && typeof wanted === "number"
    ? Math.abs(actual - wanted) < 1e-9
    : JSON.stringify(actual) === JSON.stringify(wanted);
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗ FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(actual)}, wanted ${JSON.stringify(wanted)})`}`);
}

// ── Pip geometry ─────────────────────────────────────────────────────────────
expect("EUR_USD pip (location -4)", pipSize(-4), 0.0001);
expect("JPY-style pip (location -2)", pipSize(-2), 0.01);
expect("XAU_USD pip (location -1)", pipSize(-1), 0.1);

// ── Margin: notional × marginRate, NOT notional/leverage ────────────────────
// 10,000 EUR_USD @ 1.10 at 3.33% margin (≈30:1) → $366.30
expect("margin 10k EUR_USD @1.10 3.33%", requiredMarginUsd(10_000, 1.10, 0.0333), 366.3);
// 5 XAU_USD @ 2400 at 5% → $600
expect("margin 5oz gold @2400 5%", requiredMarginUsd(5, 2400, 0.05), 600);

// ── Min stop distance: max(2×spread, 2 pips) ────────────────────────────────
// Tight 0.6-pip spread → the 2-pip floor wins.
expect("tight spread → 2-pip floor", minStopDistancePrice(-4, 1.10000, 1.10006), 0.0002);
// Wide 3-pip spread → 2×spread wins.
expect("wide spread → 2×spread", minStopDistancePrice(-4, 1.1000, 1.1003), 0.0006);
// No live quote (bid/ask 0) → still enforces the 2-pip floor.
expect("no quote → 2-pip floor", minStopDistancePrice(-4, 0, 0), 0.0002);
// Crossed/garbage quote (ask ≤ bid) → spread treated as 0, floor holds.
expect("crossed quote → floor", minStopDistancePrice(-4, 1.1003, 1.1000), 0.0002);

// ── Unit rounding: truncates, never rounds up past the risk-sized amount ────
expect("whole units truncate", roundUnits(1234.9, 0), 1234);
expect("fractional precision", roundUnits(12.3456, 1), 12.3);
expect("already precise unchanged", roundUnits(500, 0), 500);

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll forex sizing checks passed.");
