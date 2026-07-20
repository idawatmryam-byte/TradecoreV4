/**
 * Offline verification for src/lib/forexSizing.ts — the forex-specific
 * pieces layered on top of the (unchanged) dollarRisk math: pip geometry,
 * OANDA margin (marginRate × notional), the min-stop-distance guard, and
 * unit rounding.
 *
 * Run:  tsx harness/forex-sizing.test.ts   (exit 0 = all pass)
 */
import { pipSize, requiredMarginUsd, minStopDistancePrice, roundUnits } from "../src/lib/forexSizing";
import {
  netRewardRisk,
  MIN_VIABLE_REWARD_RISK,
  FOREX_COST_RATE,
  FOREX_SLIPPAGE_RATE,
} from "../src/lib/tradingCosts";
import { feeViability } from "../src/lib/strategies/toolkit";

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

// ── Cost model regression: the bug that vetoed every forex trade ────────────
// A representative FX plan from the live seeds ($10 risk / $12 target on
// $5000 notional): entry 1.08500, stop 0.2% away, target 0.24% away — a
// clean 1.2:1 gross trade. With CRYPTO cost defaults (0.1% fee + 0.05%
// slippage per leg = 0.3% round trip) the round-trip cost EXCEEDS the
// entire reward, so netRewardRisk goes negative and the selector's 0.5
// floor rejects it — which is exactly what the live decisions journal
// showed on every forex scan ("net reward:risk -0.14 below 0.5 floor").
// With the real FX rates the same plan clears the floor comfortably.
const fxEntry = 1.085;
const fxStop = fxEntry * (1 - 0.002); // -0.20%
const fxTarget = fxEntry * (1 + 0.0024); // +0.24%

const rrCrypto = netRewardRisk(fxEntry, fxStop, fxTarget, "long");
const rrForex = netRewardRisk(fxEntry, fxStop, fxTarget, "long", FOREX_COST_RATE, FOREX_SLIPPAGE_RATE);
expect("FX plan REJECTED under crypto cost defaults (the old bug)", rrCrypto < MIN_VIABLE_REWARD_RISK, true);
expect("crypto costs make the FX reward net-negative", rrCrypto <= 0, true);
expect("same FX plan CLEARS the floor at forex costs", rrForex >= MIN_VIABLE_REWARD_RISK, true);
// (0.24% - 0.03%) / (0.20% + 0.03%) ≈ 0.913 net — comfortably above 0.5.
expect("forex net RR ≈ 0.91", Math.abs(rrForex - 0.9130) < 0.001, true);

// Short side symmetric.
const fxStopS = fxEntry * (1 + 0.002);
const fxTargetS = fxEntry * (1 - 0.0024);
const rrShort = netRewardRisk(fxEntry, fxStopS, fxTargetS, "short", FOREX_COST_RATE, FOREX_SLIPPAGE_RATE);
expect("short FX plan clears the floor at forex costs", rrShort >= MIN_VIABLE_REWARD_RISK, true);

// feeViability threads the same rates (strategy pre-check parity with the gate).
expect(
  "feeViability viable at forex rates",
  feeViability(fxEntry, fxStop, fxTarget, "long", FOREX_COST_RATE, FOREX_SLIPPAGE_RATE).viable,
  true,
);
expect("feeViability still rejects at crypto defaults", feeViability(fxEntry, fxStop, fxTarget, "long").viable, false);

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll forex sizing checks passed.");
