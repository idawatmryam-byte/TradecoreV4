/**
 * Offline verification for src/lib/autopsy/diagnose.ts — the honesty rules
 * of the Optimization Autopsy: verdict gating (insufficient data / no
 * out-of-sample edge / improved), evidence built from measured numbers, and
 * the staged candidate grids' shape and bounds.
 *
 * Run:  tsx harness/autopsy.test.ts   (exit 0 = all pass)
 */
import {
  diagnose, buildFindings, dollarPlanGrid, timingGrid,
  MIN_TRADES_FOR_VERDICT, MIN_PF_EDGE,
  type AutopsyParams, type WindowMetrics,
} from "../src/lib/autopsy/diagnose";

let failures = 0;
function expect(name: string, cond: boolean, detail = "") {
  if (!cond) failures++;
  console.log(`${cond ? "✓" : "✗ FAIL"}  ${name}${cond ? "" : `  ${detail}`}`);
}

const params = (over: Partial<AutopsyParams> = {}): AutopsyParams => ({
  maxLossUsdt: 10, targetProfitUsdt: 20, confidenceThreshold: 40, maxHoldingSeconds: 3600, ...over,
});
const metrics = (over: Partial<WindowMetrics> = {}): WindowMetrics => ({
  totalTrades: 30, winRate: 0.4, profitFactor: 0.9, sharpeRatio: -0.1, maxDrawdown: 0.05, totalPnl: -12,
  exitReasons: { stop_loss: 18, take_profit: 6, timeout: 6 }, ...over,
});

// ── Verdict gating ──────────────────────────────────────────────────────────
expect("insufficient data below trade floor",
  diagnose(params(), metrics({ totalTrades: MIN_TRADES_FOR_VERDICT - 1 }), null, null).verdict === "insufficient_data");
expect("no validation metrics → insufficient",
  diagnose(params(), null, null, null).verdict === "insufficient_data");
expect("no candidate → no_better",
  diagnose(params(), metrics(), null, null).verdict === "no_better");

// A candidate that beats train but NOT validation must not become a suggestion.
const marginal = metrics({ profitFactor: 0.9 * MIN_PF_EDGE * 0.99 });
expect("sub-threshold validation edge → no_better",
  diagnose(params(), metrics(), params({ maxLossUsdt: 20 }), marginal).verdict === "no_better");

const clearlyBetter = metrics({ profitFactor: 1.4, winRate: 0.55, exitReasons: { stop_loss: 8, take_profit: 14, timeout: 8 } });
const improved = diagnose(params(), metrics(), params({ maxLossUsdt: 20 }), clearlyBetter);
expect("real validation edge → improved", improved.verdict === "improved");
expect("improved names the killer parameter", improved.summary.includes("Max Loss"), improved.summary);
expect("improved carries the honesty caveat", improved.summary.includes("not a guarantee"));

// ── Findings: measured evidence, biggest mover first ────────────────────────
const cur = params();
const best = params({ maxLossUsdt: 20, confidenceThreshold: 50 }); // +100% vs +25% change
const findings = buildFindings(cur, best, metrics(), clearlyBetter);
expect("only changed params produce findings", findings.length === 2, `got ${findings.length}`);
expect("biggest relative change ranks first", findings[0]!.param === "maxLossUsdt", findings[0]!.param);
expect("evidence cites measured stop-out share (60%)", findings[0]!.evidence.includes("60%"), findings[0]!.evidence);
expect("evidence cites measured win rates", findings[0]!.evidence.includes("40%") && findings[0]!.evidence.includes("55%"));
expect("action names the Strategies-page field", findings[0]!.action.includes("Max Loss per trade"));

const unchanged = buildFindings(cur, params(), metrics(), clearlyBetter);
expect("identical params → zero findings", unchanged.length === 0);

// ── Candidate grids: bounded, exclude current, sane values ──────────────────
const g1 = dollarPlanGrid(params());
expect("dollar grid is 15 combos (4×4 − current)", g1.length === 15, `got ${g1.length}`);
expect("dollar grid never re-tests current", !g1.some((p) => p.maxLossUsdt === 10 && p.targetProfitUsdt === 20));
expect("dollar grid keeps other knobs fixed", g1.every((p) => p.confidenceThreshold === 40 && p.maxHoldingSeconds === 3600));

const g2 = timingGrid(params());
expect("timing grid is 8 combos (3×3 − base)", g2.length === 8, `got ${g2.length}`);
expect("confidence clamped to ≥0", timingGrid(params({ confidenceThreshold: 5 })).every((p) => p.confidenceThreshold >= 0));
expect("confidence clamped to ≤95", timingGrid(params({ confidenceThreshold: 92 })).every((p) => p.confidenceThreshold <= 95));
expect("hold floored at 5 minutes", timingGrid(params({ maxHoldingSeconds: 400 })).every((p) => p.maxHoldingSeconds >= 300));
expect("full autopsy stays ≈30 backtests", 1 + g1.length + g2.length + 1 + 3 <= 30, `${1 + g1.length + g2.length + 4}`);

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll autopsy checks passed.");
