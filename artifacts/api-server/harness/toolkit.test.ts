/**
 * Offline verification for the trader toolkit (lib/strategies/toolkit.ts).
 *
 * This is a money path: solveLeverage() chooses the leverage, stop and target
 * for every native decide() strategy. These assert the exact invariants:
 *   - the solver never exceeds the user's leverage cap,
 *   - the chosen stop always clears every safety floor (noise band, exchange
 *     minimum placeable stop, structural invalidation),
 *   - higher caps never produce a WIDER stop (monotonicity),
 *   - the solver's numbers agree with planDollarRiskFractions (single source
 *     of truth for fee math),
 *   - infeasible configurations are rejected with a reason, never silently
 *     downgraded,
 *   - timeFeasible mirrors the per-coin fit target-reachability math.
 *
 * Run:  tsx harness/toolkit.test.ts   (exit 0 = all pass)
 */
import { solveLeverage, timeFeasible, feeViability } from "../src/lib/strategies/toolkit";
import { planDollarRiskFractions } from "../src/lib/dollarRisk";
import { MIN_PROTECTIVE_STOP_PCT } from "../src/lib/futuresMath";
import { MIN_STOP_ATR_MULT } from "../src/lib/strategies/selector";
import { TARGET_REACH_K } from "../src/lib/strategies/base";
import type { SignalRow } from "../src/lib/strategy";

let failures = 0;
function check(name: string, ok: boolean, extra = "") {
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗ FAIL"}  ${name}${ok ? "" : `  ${extra}`}`);
}

const row = (atrPercent: number, candleMinutes = 1): SignalRow =>
  ({ atrPercent, candleMinutes } as unknown as SignalRow);

// ── Solver respects the cap and the floors ───────────────────────────────────
{
  // Margin $300, max loss $50, target $45 — the 20-min strategy's default plan.
  // ATR 0.05%/1m → noise floor 0.075%; exchange floor 0.35% binds instead.
  const s = solveLeverage({
    entryPrice: 60000, side: "long", marketType: "futures",
    marginUsdt: 300, maxLossUsdt: 50, targetProfitUsdt: 45,
    leverageCap: 50, atrPercent: 0.05,
  });
  check("solver finds a feasible plan", s.feasible, s.reason ?? "");
  check("leverage within cap", s.leverage >= 1 && s.leverage <= 50, `got ${s.leverage}`);
  check(
    "stop clears the exchange minimum",
    s.stopDistPct >= MIN_PROTECTIVE_STOP_PCT - 1e-9,
    `stop ${s.stopDistPct.toFixed(3)}% < ${MIN_PROTECTIVE_STOP_PCT}%`,
  );
  check("binding floor identified", s.bindingFloor === "exchange-min", s.bindingFloor);

  // The old failure mode this solver exists to kill: at 50x the $50 stop on
  // $15k notional is ~0.23% — unplaceable. The solver must have chosen LESS
  // than 50x so the stop widened past 0.35%.
  check("solver deleveraged below the cap to widen the stop", s.leverage < 50, `got ${s.leverage}`);

  // Agreement with the audited dollar math at the chosen leverage.
  const f = planDollarRiskFractions({
    marketType: "futures", tradeAmountUsdt: 300, leverage: s.leverage,
    maxLossUsdt: 50, targetProfitUsdt: 45, feeRate: 0.0005,
  }, undefined, false);
  check("slFraction matches planDollarRiskFractions", Math.abs(s.slFraction - f.slFraction) < 1e-12);
  check("tpFraction matches planDollarRiskFractions", Math.abs(s.tpFraction - f.tpFraction) < 1e-12);
  check("notional = margin × leverage", Math.abs(s.notionalUsdt - 300 * s.leverage) < 1e-9);
  check("qty = notional / entry", Math.abs(s.qty - s.notionalUsdt / 60000) < 1e-12);
}

// ── Noise band binds when the coin is volatile ───────────────────────────────
{
  // ATR 0.4%/1m → noise floor 0.6% > exchange 0.35%.
  const s = solveLeverage({
    entryPrice: 100, side: "short", marketType: "futures",
    marginUsdt: 500, maxLossUsdt: 60, targetProfitUsdt: 60,
    leverageCap: 20, atrPercent: 0.4,
  });
  check("volatile coin: feasible", s.feasible, s.reason ?? "");
  check("volatile coin: noise band binds", s.bindingFloor === "noise-band", s.bindingFloor);
  check(
    "volatile coin: stop clears ATR noise floor",
    s.stopDistPct >= 0.4 * MIN_STOP_ATR_MULT - 1e-9,
    `stop ${s.stopDistPct.toFixed(3)}%`,
  );
  // Short: stop above entry, target below.
  check("short: stop above entry", s.slPrice > 100);
  check("short: target below entry", s.tpPrice < 100);
}

// ── Structural invalidation pushes the stop wider than both floors ───────────
{
  const s = solveLeverage({
    entryPrice: 100, side: "long", marketType: "futures",
    marginUsdt: 1000, maxLossUsdt: 100, targetProfitUsdt: 120,
    leverageCap: 10, atrPercent: 0.05,
    invalidationPrice: 98.5, // thesis wrong 1.5% below entry
  });
  check("invalidation: feasible", s.feasible, s.reason ?? "");
  check("invalidation floor binds", s.bindingFloor === "invalidation", s.bindingFloor);
  check("stop at/beyond the invalidation level", s.slPrice <= 98.5 + 1e-9, `sl ${s.slPrice}`);
}

// ── Monotonicity: a higher cap never widens the stop ─────────────────────────
{
  const base = {
    entryPrice: 60000, side: "long" as const, marketType: "futures" as const,
    marginUsdt: 300, maxLossUsdt: 50, targetProfitUsdt: 45, atrPercent: 0.1,
  };
  let prevStop = Infinity;
  let ok = true;
  for (const cap of [2, 5, 10, 25, 50]) {
    const s = solveLeverage({ ...base, leverageCap: cap });
    if (!s.feasible) continue;
    if (s.stopDistPct > prevStop + 1e-9) ok = false;
    prevStop = s.stopDistPct;
  }
  check("raising the cap never widens the stop", ok);
}

// ── Infeasible configs are rejected with a reason ────────────────────────────
{
  const noPlan = solveLeverage({
    entryPrice: 100, side: "long", marketType: "futures",
    marginUsdt: 300, maxLossUsdt: 0, targetProfitUsdt: 45,
    leverageCap: 10, atrPercent: 0.1,
  });
  check("missing dollar plan → rejected", !noPlan.feasible && !!noPlan.reason);

  // Fees exceed max loss at EVERY leverage 1..cap: margin $10k, max loss $5.
  // Even at 1x, round-trip fees = 10000×0.0005×2 = $10 > $5.
  const feesEat = solveLeverage({
    entryPrice: 100, side: "long", marketType: "futures",
    marginUsdt: 10000, maxLossUsdt: 5, targetProfitUsdt: 10,
    leverageCap: 10, atrPercent: 0.05,
  });
  check("fees ≥ max loss at all leverages → rejected", !feesEat.feasible && !!feesEat.reason);

  // Tiny max loss on huge margin: stop can never clear the exchange floor.
  const tooTight = solveLeverage({
    entryPrice: 100, side: "long", marketType: "futures",
    marginUsdt: 20000, maxLossUsdt: 25, targetProfitUsdt: 25,
    leverageCap: 50, atrPercent: 0.05,
  });
  check("stop can't clear floors at any leverage → rejected", !tooTight.feasible, tooTight.reason ?? "");
}

// ── Spot: leverage pinned to 1, no exchange floor ────────────────────────────
{
  const s = solveLeverage({
    entryPrice: 100, side: "long", marketType: "spot",
    marginUsdt: 1000, maxLossUsdt: 20, targetProfitUsdt: 30,
    leverageCap: 25, atrPercent: 0.05,
  });
  check("spot: leverage is 1 regardless of cap", s.feasible && s.leverage === 1, `lev ${s.leverage}`);
}

// ── timeFeasible mirrors the per-coin fit reachability math ──────────────────
{
  // ATR 0.1%/1m, hold 20min → reachable = 0.1×√20×1.5 ≈ 0.67%.
  const reachable = 0.1 * Math.sqrt(20) * TARGET_REACH_K;
  const ok = timeFeasible(0.005, row(0.1), 20 * 60); // 0.5% target < reachable
  check("modest target within window → feasible", ok.feasible);
  check(
    "reachablePct matches ATR×√candles×K",
    Math.abs(ok.reachablePct - reachable) < 1e-9,
    `got ${ok.reachablePct}, wanted ${reachable}`,
  );
  const no = timeFeasible(0.02, row(0.1), 20 * 60); // 2% target ≫ reachable
  check("oversized target → infeasible with reason", !no.feasible && !!no.reason);
  check("expectedSeconds grows with the square of the target", no.expectedSeconds > ok.expectedSeconds);
}

// ── feeViability agrees with the central floor ───────────────────────────────
{
  const good = feeViability(100, 98, 104, "long"); // 2:1 gross
  check("healthy R:R is viable", good.viable, `netRR ${good.netRR}`);
  const bad = feeViability(100, 99.7, 100.2, "long"); // reward inside costs
  check("reward inside costs → not viable", !bad.viable && !!bad.reason);
}

console.log(failures === 0 ? "\nAll toolkit checks passed." : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
