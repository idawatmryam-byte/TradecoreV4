/**
 * Offline verification for src/lib/futuresMath.ts — liquidation estimate and
 * the distance-proportional stop-vs-liquidation guard.
 *
 * Pins the buffer-formula bug this replaces: the old check (stop within 5%
 * OF PRICE of the liquidation) rejected EVERY entry at leverage ≳ 20x,
 * because the whole liquidation distance at 25x (~3.6% of price) was smaller
 * than the buffer — the threshold sat above the entry price itself.
 *
 * Run:  tsx harness/futures-math.test.ts   (exit 0 = all pass)
 */
import { estimateLiquidationPrice, stopTooCloseToLiquidation } from "../src/lib/futuresMath";

let failures = 0;
function expect(name: string, actual: unknown, wanted: unknown) {
  // Exact equality first (covers booleans AND Infinity, where Infinity−Infinity
  // is NaN and would wrongly fail a tolerance check); tolerance for finite numbers.
  const ok = actual === wanted
    || (typeof wanted === "number" && typeof actual === "number" && Math.abs(actual - wanted) < 1e-9);
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗ FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(actual)}, wanted ${JSON.stringify(wanted)})`}`);
}

// ── estimateLiquidationPrice (mmr 0.004) ─────────────────────────────────────
expect("liq long 10x @100 → 90.4", estimateLiquidationPrice(100, "long", 10), 100 * (1 - (0.1 - 0.004)));
expect("liq short 10x @100 → 109.6", estimateLiquidationPrice(100, "short", 10), 100 * (1 + (0.1 - 0.004)));
expect("liq long 1x → unreachable (0)", estimateLiquidationPrice(100, "long", 1), 0);
expect("liq short 1x → unreachable (∞)", estimateLiquidationPrice(100, "short", 1), Infinity);

// ── stopTooCloseToLiquidation: 1.5% stop at various leverage ─────────────────
// liq distance: 10x → 9.6%, 25x → 3.6%, 50x → 1.6%. Buffer: stopDist × 1.25 = 1.875%.
expect("10x + 1.5% stop → SAFE", stopTooCloseToLiquidation(100, 98.5, estimateLiquidationPrice(100, "long", 10)), false);
expect("25x + 1.5% stop → SAFE (old formula rejected this!)", stopTooCloseToLiquidation(100, 98.5, estimateLiquidationPrice(100, "long", 25)), false);
expect("50x + 1.5% stop → UNSAFE (1.6% liq < 1.875% buffered stop)", stopTooCloseToLiquidation(100, 98.5, estimateLiquidationPrice(100, "long", 50)), true);
// Short mirror at 25x: stop above entry, liq above entry.
expect("short 25x + 1.5% stop → SAFE", stopTooCloseToLiquidation(100, 101.5, estimateLiquidationPrice(100, "short", 25)), false);
// Micro-scalping's tight 0.8% stop still fits at 50x? liq 1.6% ≥ 0.8×1.25=1.0% → safe.
expect("50x + 0.8% stop → SAFE (tight stop fits inside 1.6% liq)", stopTooCloseToLiquidation(100, 99.2, estimateLiquidationPrice(100, "long", 50)), false);
// Stop BEYOND liquidation must always be unsafe.
expect("stop beyond liquidation → UNSAFE", stopTooCloseToLiquidation(100, 90, estimateLiquidationPrice(100, "long", 25)), true);
// Leverage ≤ 1 (spot-like): liquidation unreachable → never unsafe.
expect("1x short (liq ∞) → SAFE", stopTooCloseToLiquidation(100, 101.5, estimateLiquidationPrice(100, "short", 1)), false);

console.log(failures === 0 ? "\nAll assertions passed." : `\n${failures} assertion(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
