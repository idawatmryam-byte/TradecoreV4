/**
 * Offline verification for computeAdaptiveSLTP (strategies/base.ts) — the
 * volatility-adaptive target fix for the 87–94%-timeout pathology measured
 * across 5 real-data backtests (2,237 trades).
 *
 * Uses REAL-WORLD ATR numbers: BTC 1m ATR ≈ 0.05% (the regime where fixed
 * targets were 6–8× out of reach), SOL ≈ 0.15%, and a high-vol case where
 * the cap must NOT engage (config used as-is — this is why the synthetic
 * harness shows byte-identical results: its volatility is ample).
 *
 * Run:  tsx harness/adaptive-sltp.test.ts   (exit 0 = all pass)
 */
import { computeAdaptiveSLTP, TARGET_REACH_K, type StrategyConfig } from "../src/lib/strategies/base";

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

const momentumLike = {
  stopLossPercent: 1.5, takeProfitPercent: 3.0, maxHoldingSeconds: 3600,
} as StrategyConfig;
const scalpLike = {
  stopLossPercent: 0.8, takeProfitPercent: 1.2, maxHoldingSeconds: 600,
} as StrategyConfig;

// ── BTC-like calm regime (ATR% 0.05/min): targets must be volatility-capped ──
{
  const r = computeAdaptiveSLTP(100, momentumLike, "long", 0.05);
  const reachable = 0.05 * Math.sqrt(60) * TARGET_REACH_K; // ≈ 0.581%
  expect("BTC momentum: volCapped", r.volCapped, true);
  approx("BTC momentum: tpPercent = reachable (≈0.581)", r.tpPercent, reachable);
  approx("BTC momentum: R:R preserved (sl = tp/2)", r.slPercent, reachable / 2);
  approx("BTC momentum: tpPrice consistent", r.tpPrice, 100 * (1 + reachable / 100));
}
{
  const r = computeAdaptiveSLTP(100, scalpLike, "long", 0.05);
  const reachable = 0.05 * Math.sqrt(10) * TARGET_REACH_K; // ≈ 0.237% — below fee floor;
  approx("BTC scalp: tp capped to ≈0.237% (cost gate will refuse downstream)", r.tpPercent, reachable);
}

// ── SOL-like (ATR% 0.15/min): scalp becomes reachable and viable ────────────
{
  const r = computeAdaptiveSLTP(100, scalpLike, "long", 0.15);
  const reachable = 0.15 * Math.sqrt(10) * TARGET_REACH_K; // ≈ 0.712%
  expect("SOL scalp: volCapped", r.volCapped, true);
  approx("SOL scalp: tpPercent ≈ 0.712", r.tpPercent, reachable);
}

// ── High-vol: configured targets already reachable → used EXACTLY as-is ─────
{
  const r = computeAdaptiveSLTP(100, scalpLike, "long", 0.4); // reachable ≈ 1.90% > 1.2%
  expect("high-vol: NOT capped", r.volCapped, false);
  expect("high-vol: tpPercent = config", r.tpPercent, 1.2);
  expect("high-vol: slPercent = config", r.slPercent, 0.8);
}

// ── Short side mirrors (SL above entry, TP below) ────────────────────────────
{
  const r = computeAdaptiveSLTP(100, momentumLike, "short", 0.05);
  expect("short: SL above entry", r.slPrice > 100, true);
  expect("short: TP below entry", r.tpPrice < 100, true);
}

// ── Degenerate inputs fall back to config (no scaling, no NaN) ───────────────
{
  const r = computeAdaptiveSLTP(100, momentumLike, "long", 0);
  expect("atr=0: uncapped, config used", r.volCapped === false && r.tpPercent === 3.0, true);
}

console.log(failures === 0 ? "\nAll assertions passed." : `\n${failures} assertion(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
