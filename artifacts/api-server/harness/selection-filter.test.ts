/**
 * Offline verification for the Selection Filter analyzer (edge Phase 1):
 *  - the significance gate (a cell only VETOes with enough sample AND
 *    statistical confidence — noise must NOT trigger a veto)
 *  - WATCH / KEEP / CONCENTRATE classification
 *  - the zero-variance guard (a perfectly consistent loser is the strongest
 *    veto, not a tStat-0 dead zone)
 *  - projected combined impact math + the `ready` flag
 *
 * Run:  tsx harness/selection-filter.test.ts   (exit 0 = all pass)
 */
import { analyzeSelection, VETO_MIN_SAMPLE } from "../src/lib/selectionFilter";
import type { ForensicTradeRow } from "../src/lib/edgeForensics";

let failures = 0;
function expect(name: string, actual: unknown, wanted: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(wanted);
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗ FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(actual)}, wanted ${JSON.stringify(wanted)})`}`);
}

const HOUR_MS = 3600_000;
// entry 100 / stop 99 / qty 10 → planned risk = $10, so |pnl| ≥ $1 is a
// decided win/loss (not a scratch).
function mk(strategyId: string, symbol: string, pnl: number, hourUtc = 12): ForensicTradeRow {
  return {
    pnl, grossPnl: pnl, feesUsdt: 0.2,
    entryPrice: 100, plannedStopLoss: 99, stopLoss: 99,
    plannedQuantity: 10, quantity: 10,
    exitReason: pnl > 0 ? "take_profit" : "stop_loss",
    strategyId, strategyName: strategyId, symbol,
    // Fixed calendar day, chosen hour.
    entryTimeMs: Date.UTC(2026, 5, 1) + hourUtc * HOUR_MS,
    holdingSeconds: 600, tp1Filled: false,
  };
}
/** n trades cycling through `pnls` (gives non-zero variance) for one cell. */
function cell(strategyId: string, symbol: string, n: number, pnls: number[], hourUtc = 12): ForensicTradeRow[] {
  return Array.from({ length: n }, (_, i) => mk(strategyId, symbol, pnls[i % pnls.length]!, hourUtc));
}

// ── 1. A large, consistently-negative cell → VETO ───────────────────────────
{
  const rows = cell("loser", "AAAUSDT", 24, [-4, -5, -6], 3);
  const rep = analyzeSelection(rows);
  const strat = rep.cells.find((c) => c.dimension === "strategy" && c.key === "loser")!;
  expect("consistent-loss strategy vetoed", strat.verdict, "veto");
  expect("veto reported in candidates", rep.vetoCandidates.some((c) => c.key === "loser"), true);
  expect("data is ready to act", rep.ready, true);
  // All 24 trades fall in the vetoed strategy (and vetoed symbol) → all filtered.
  expect("projected filters all 24 trades", rep.projected.vetoedTrades, 24);
  expect("projected filtered pnl ≈ 24×−5", rep.projected.filteredPnl, -120);
}

// ── 2. Zero-variance loser is the STRONGEST veto (not a tStat-0 dead zone) ───
{
  const rows = cell("flatloss", "BBBUSDT", VETO_MIN_SAMPLE, [-5], 4);
  const rep = analyzeSelection(rows);
  const strat = rep.cells.find((c) => c.key === "flatloss")!;
  expect("zero-variance loss → Infinity tStat", strat.tStat, Infinity);
  expect("zero-variance loss vetoed", strat.verdict, "veto");
}

// ── 3. High-variance, barely-negative mean → NOT veto (noise) ────────────────
{
  // mean ≈ −1 but swings ±50 → standard error large → not significant.
  const rows = cell("noisy", "CCCUSDT", 24, [50, -52], 5);
  const rep = analyzeSelection(rows);
  const strat = rep.cells.find((c) => c.key === "noisy")!;
  expect("noisy cell is negative on average", strat.expectancy < 0, true);
  expect("noisy cell NOT vetoed (insufficient confidence)", strat.verdict === "veto", false);
  expect("noisy cell is at most WATCH", ["watch", "keep"].includes(strat.verdict), true);
}

// ── 4. Small negative cell → WATCH, never VETO ──────────────────────────────
{
  const rows = cell("small", "DDDUSDT", 10, [-3, -4, -5], 6);
  const rep = analyzeSelection(rows);
  const strat = rep.cells.find((c) => c.key === "small")!;
  expect("10-trade negative cell is WATCH", strat.verdict, "watch");
  expect("WATCH does not filter any trades", rep.projected.vetoedTrades, 0);
}

// ── 5. Large positive cell → CONCENTRATE ────────────────────────────────────
{
  const rows = cell("winner", "EEEUSDT", 24, [4, 5, 6], 7);
  const rep = analyzeSelection(rows);
  const strat = rep.cells.find((c) => c.key === "winner")!;
  expect("consistent-win strategy → concentrate", strat.verdict, "concentrate");
  expect("concentrate makes data ready", rep.ready, true);
}

// ── 6. Too little data → KEEP, not ready ────────────────────────────────────
{
  const rows = cell("tiny", "FFFUSDT", 4, [-5], 8);
  const rep = analyzeSelection(rows);
  const strat = rep.cells.find((c) => c.key === "tiny")!;
  expect("4-trade cell is KEEP", strat.verdict, "keep");
  expect("not ready to act", rep.ready, false);
  expect("largest cell size surfaced", rep.projected.largestCellTrades, 4);
}

// ── 7. Empty input is handled ───────────────────────────────────────────────
{
  const rep = analyzeSelection([]);
  expect("empty → not ready", rep.ready, false);
  expect("empty → no veto candidates", rep.vetoCandidates.length, 0);
}

// ── 8. A pair (strategy×symbol) veto filters via the pair key ────────────────
{
  // Strategy "mixed" wins on GOOD, loses on BAD. Neither the strategy nor the
  // symbol alone is a clean veto, but the mixed·BAD PAIR is.
  const rows = [
    ...cell("mixed", "GOODUSDT", 20, [5], 9),
    ...cell("mixed", "BADUSDT", 20, [-5], 10),
  ];
  const rep = analyzeSelection(rows);
  const pair = rep.cells.find((c) => c.dimension === "strategy_symbol" && c.key === "mixed|BADUSDT")!;
  expect("losing pair vetoed", pair.verdict, "veto");
  const goodPair = rep.cells.find((c) => c.dimension === "strategy_symbol" && c.key === "mixed|GOODUSDT")!;
  expect("winning pair concentrated", goodPair.verdict, "concentrate");
  // Only the 20 BAD-symbol trades are filtered (GOOD stays).
  expect("pair veto filters exactly the losing side", rep.projected.vetoedTrades, 20);
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll Selection Filter checks passed.");
