/**
 * Offline verification for the dollar-based risk model (lib/dollarRisk.ts).
 *
 * This is a money path: it sets the real stop-loss and take-profit on every
 * live/backtest trade in dollar mode. These assert the exact invariants:
 *   - realized net loss at the stop equals the configured max loss,
 *   - realized net profit at the target equals the configured target,
 *   - SL/TP price distances are price-independent (fractions of entry),
 *   - futures leverage sets the liquidation distance and the safety verdict,
 *   - short mirrors long, and infeasible/unsafe configs are flagged.
 *
 * Run:  tsx harness/dollar-risk.test.ts   (exit 0 = all pass)
 */
import { planDollarRisk, planDollarRiskFractions, maxSafeLeverage } from "../src/lib/dollarRisk";

let failures = 0;
function approx(name: string, actual: number, wanted: number, tol = 1e-6) {
  const ok = Math.abs(actual - wanted) <= tol;
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗ FAIL"}  ${name}${ok ? "" : `  (got ${actual}, wanted ~${wanted})`}`);
}
function expect(name: string, actual: unknown, wanted: unknown) {
  const ok = actual === wanted;
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗ FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(actual)}, wanted ${JSON.stringify(wanted)})`}`);
}

// ── Spot long: net P&L at SL/TP matches the configured dollars exactly ────────
{
  // Spot notional $1000, fee 0.1%/leg → round-trip fees = 1000×0.001×2 = $2.
  // Max loss $50 → gross price loss must be $48 (so net = 48 + 2 = 50).
  // Target $100 → gross price gain must be $102 (net = 102 − 2 = 100).
  const cfg = { marketType: "spot" as const, tradeAmountUsdt: 1000, leverage: 1, maxLossUsdt: 50, targetProfitUsdt: 100 };
  const plan = planDollarRisk(100, "long", cfg);
  approx("spot qty = notional/entry", plan.qty, 10);
  approx("spot expected net loss == maxLoss", plan.expectedLossUsdt, 50);
  approx("spot expected net profit == target", plan.expectedProfitUsdt, 100);
  approx("spot SL price", plan.slPrice, 100 * (1 - 48 / 1000)); // 95.2
  approx("spot TP price", plan.tpPrice, 100 * (1 + 102 / 1000)); // 110.2
  approx("spot reward:risk", plan.rewardRiskRatio, 2);
  expect("spot feasible", plan.feasible, true);
  expect("spot safe (no liquidation)", plan.safe, true);
  expect("spot has no liquidation price", plan.liquidationPrice, null);
}

// ── Price-independence: same config, different entry → identical fractions ─────
{
  const cfg = { marketType: "spot" as const, tradeAmountUsdt: 1000, leverage: 1, maxLossUsdt: 50, targetProfitUsdt: 100 };
  const a = planDollarRisk(100, "long", cfg);
  const b = planDollarRisk(37_000, "long", cfg);
  approx("SL fraction is price-independent", a.slFraction, b.slFraction);
  approx("TP fraction is price-independent", a.tpFraction, b.tpFraction);
  approx("high-price net loss still == maxLoss", b.expectedLossUsdt, 50, 1e-4);
}

// ── Short mirrors long: SL above, TP below, same dollar outcomes ──────────────
{
  const cfg = { marketType: "spot" as const, tradeAmountUsdt: 1000, leverage: 1, maxLossUsdt: 50, targetProfitUsdt: 100 };
  const s = planDollarRisk(100, "short", cfg);
  approx("short SL sits ABOVE entry", s.slPrice, 100 * (1 + 48 / 1000)); // 104.8
  approx("short TP sits BELOW entry", s.tpPrice, 100 * (1 - 102 / 1000)); // 89.8
  approx("short expected net loss == maxLoss", s.expectedLossUsdt, 50);
  approx("short expected net profit == target", s.expectedProfitUsdt, 100);
}

// ── Futures: leverage multiplies notional, sets liquidation distance ──────────
{
  // Margin $100 × 10x = $1000 notional. Futures fee 0.05%/leg → RT = 1000×0.0005×2 = $1.
  // Max loss $50 → gross loss $49 → SL fraction 49/1000 = 4.9%.
  // Liquidation distance ≈ 1/10 − 0.004 = 9.6%. 9.6% ≥ 4.9%×1.25 (6.125%) → SAFE.
  const cfg = { marketType: "futures" as const, tradeAmountUsdt: 100, leverage: 10, maxLossUsdt: 50, targetProfitUsdt: 100 };
  const plan = planDollarRisk(100, "long", cfg);
  approx("futures notional = margin×leverage", plan.notionalUsdt, 1000);
  approx("futures qty = notional/entry", plan.qty, 10);
  approx("futures SL fraction", plan.slFraction, 49 / 1000);
  approx("futures liquidation ~9.6%", plan.liquidationPercent ?? -1, 9.6, 1e-6);
  expect("futures 10x is safe", plan.safe, true);
  expect("futures feasible", plan.feasible, true);
}

// ── Unsafe: a max loss near the margin puts the stop beyond liquidation ────────
{
  // In the dollar model, higher leverage shrinks the stop % (bigger notional),
  // so leverage alone is self-protecting. What's dangerous is choosing a max
  // loss close to your margin: margin $50 × 50x = $2500 notional; max loss $50
  // ≈ the whole margin → stop ~1.9% while liquidation is only ~1.6% away → UNSAFE.
  const cfg = { marketType: "futures" as const, tradeAmountUsdt: 50, leverage: 50, maxLossUsdt: 50, targetProfitUsdt: 100 };
  const f = planDollarRiskFractions(cfg);
  expect("stop beyond liquidation → UNSAFE", f.safe, false);
  expect("unsafe plan carries a suggestion", typeof f.suggestion === "string" && f.suggestion.length > 0, true);
  const safeLev = maxSafeLeverage(cfg);
  expect("a safe leverage exists at/below current", safeLev >= 1 && safeLev < 50, true);
}

// ── Infeasible: fees meet/exceed the max loss → no placeable stop ─────────────
{
  // Notional $10000 spot → RT fees = 10000×0.001×2 = $20. Max loss $10 < fees → infeasible.
  const cfg = { marketType: "spot" as const, tradeAmountUsdt: 10000, leverage: 1, maxLossUsdt: 10, targetProfitUsdt: 20 };
  const f = planDollarRiskFractions(cfg);
  expect("fees ≥ max loss → infeasible", f.feasible, false);
  expect("infeasible plan warns", f.warnings.length > 0, true);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
