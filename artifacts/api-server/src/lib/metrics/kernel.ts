/**
 * TradeCore Pro — Performance-metrics kernel
 *
 * ONE canonical implementation of every performance number the product shows.
 *
 * Why this exists: before it, win rate was computed four separate times with
 * three different meanings — `edgeForensics.ts` (scratch-adjusted, null on no
 * data), `routes/stats.ts` (raw, zero on no data), `backtestEngine.ts` (raw),
 * and `demoStatus.ts` (raw, today only) — and expectancy was computed over
 * `decided` trades in one place and `totalTrades` in another. A user could
 * read one win rate on Analytics and a different one from a backtest over the
 * same trades, and both were "correct". In a product whose pitch is measured
 * facts, that is a credibility bug.
 *
 * The fix is NOT to collapse those into a single number — the differences are
 * deliberate. It is to name each definition once, here, and make every caller
 * say which one it means.
 *
 * Everything in this file is pure: no DB, no clock, no I/O. Guarded by
 * harness/metrics-kernel.test.ts.
 */

// ---------------------------------------------------------------------------
// Outcome classification
// ---------------------------------------------------------------------------

export type TradeOutcome = "win" | "loss" | "scratch";

/**
 * The simple, binary view: a trade wins when it made money, full stop.
 *
 * Used by the live stats summary, the backtest metrics, and the demo overlay.
 * Deliberately has no scratch concept — see `classifyOutcome` for the view
 * that separates break-even washes from real losses.
 */
export function isWin(pnl: number): boolean {
  return pnl > 0;
}

/**
 * The forensic view: a trade is a SCRATCH when it exited at the moved-to-
 * break-even stop, or when its net P&L is inside ±10% of the planned dollar
 * risk — a wash, not a decision the market made about the thesis.
 *
 * Counting scratches as losses is what craters a raw win rate while barely
 * touching P&L, which is exactly the leak Edge Forensics exists to name.
 */
export function classifyOutcome(
  pnl: number,
  plannedRisk: number | null,
  exitReason: string | null,
): TradeOutcome {
  if (exitReason === "break_even") return "scratch";
  if (plannedRisk != null && plannedRisk > 0 && Math.abs(pnl) < SCRATCH_BAND * plannedRisk) {
    return "scratch";
  }
  return pnl > 0 ? "win" : "loss";
}

/** Half-width of the break-even band, as a fraction of planned dollar risk. */
export const SCRATCH_BAND = 0.1;

// ---------------------------------------------------------------------------
// Win rate — two definitions, differing ONLY in how they report "no data"
// ---------------------------------------------------------------------------

/**
 * wins / total, returning **0** when there are no trades.
 *
 * Used where the UI renders a percentage unconditionally (live stats summary,
 * demo overlay, backtest metrics): an empty history shows 0%.
 */
export function winRateOrZero(wins: number, total: number): number {
  return total > 0 ? wins / total : 0;
}

/**
 * wins / total, returning **null** when there are no trades.
 *
 * Used by Edge Forensics, which must distinguish "measured 0%" from "nothing
 * measured yet" — reporting a fabricated 0% is exactly the failure mode the
 * forensics are meant to expose.
 */
export function winRateOrNull(wins: number, total: number): number | null {
  return total > 0 ? wins / total : null;
}

// ---------------------------------------------------------------------------
// Expectancy — two denominators, deliberately
// ---------------------------------------------------------------------------

/**
 * Average P&L per trade taken, scratches included.
 * The backtest definition: `totalPnl / totalTrades`.
 */
export function expectancyPerTrade(totalPnl: number, totalTrades: number): number {
  return totalTrades > 0 ? totalPnl / totalTrades : 0;
}

/**
 * Average P&L per *decided* trade (scratches excluded), in dollars.
 * The Edge Forensics definition — it answers "when the market actually ruled
 * on the thesis, what did that cost or earn?"
 */
export function expectancyPerDecided(
  winPnl: number,
  lossPnl: number,
  decided: number,
): number | null {
  return decided > 0 ? (winPnl + lossPnl) / decided : null;
}

// ---------------------------------------------------------------------------
// Profit factor
// ---------------------------------------------------------------------------

/** Sentinel reported when there are gains but no losses to divide by. */
export const PROFIT_FACTOR_NO_LOSSES = 999;

/** grossProfit / grossLoss, with the no-loss sentinel. `grossLoss` is positive. */
export function profitFactor(grossProfit: number, grossLoss: number): number {
  return grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? PROFIT_FACTOR_NO_LOSSES : 0;
}

// ---------------------------------------------------------------------------
// Drawdown — two units, deliberately
// ---------------------------------------------------------------------------

/**
 * Worst peak-to-trough decline of cumulative realized P&L, **in currency**.
 * Peak starts at 0, so a history that never goes positive still reports the
 * drop from flat. This is the live stats-summary definition.
 */
export function maxDrawdownAbsolute(pnls: readonly number[]): number {
  let peak = 0;
  let running = 0;
  let maxDd = 0;
  for (const p of pnls) {
    running += p;
    if (running > peak) peak = running;
    const dd = peak - running;
    if (dd > maxDd) maxDd = dd;
  }
  return maxDd;
}

/**
 * Worst peak-to-trough decline of an equity curve, **as a fraction of the
 * running peak**. This is the backtest definition, and it is NOT comparable
 * to `maxDrawdownAbsolute` — one is dollars, one is a ratio.
 */
export function maxDrawdownFraction(
  equityCurve: readonly number[],
  startingBalance: number,
): number {
  let maxDd = 0;
  let peak = equityCurve[0] ?? startingBalance;
  for (const bal of equityCurve) {
    if (bal > peak) peak = bal;
    const dd = peak > 0 ? (peak - bal) / peak : 0;
    if (dd > maxDd) maxDd = dd;
  }
  return maxDd;
}

// ---------------------------------------------------------------------------
// Risk & R-multiples
// ---------------------------------------------------------------------------

/**
 * Planned dollar risk = |entry − stop| × qty.
 * Null when the stop distance or quantity is degenerate, so callers can tell
 * "no measurable risk" from "zero risk".
 */
export function plannedRiskDollars(
  entryPrice: number,
  stopPrice: number,
  qty: number,
): number | null {
  const dist = Math.abs(entryPrice - stopPrice);
  if (!(dist > 0) || !(qty > 0)) return null;
  return dist * qty;
}

/** Realized reward:risk in R units = net P&L ÷ planned dollar risk. */
export function realizedR(pnl: number, plannedRisk: number | null): number | null {
  if (plannedRisk == null || !(plannedRisk > 0)) return null;
  return pnl / plannedRisk;
}

// ---------------------------------------------------------------------------
// Rounding — shared so the same metric rounds identically everywhere
// ---------------------------------------------------------------------------

export const round2 = (n: number): number => Math.round(n * 100) / 100;
export const round4 = (n: number): number => Math.round(n * 10000) / 10000;
/** 8dp — the precision P&L and balances are stored and rendered at. */
export const round8 = (n: number): number => Math.round(n * 1e8) / 1e8;
