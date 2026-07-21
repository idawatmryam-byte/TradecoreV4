/**
 * TradeCore Pro — Selection Filter (analysis half)
 *
 * Edge Forensics answers "where does the losing come from?". This module
 * takes the next step and answers "which of those cells is it SAFE to stop
 * trading?" — turning the prose "candidate for the filter" verdicts into a
 * hard, sample-gated table.
 *
 * The load-bearing idea, and the reason this is only the *analysis* half:
 * on thin data, "this hour loses money" is almost always noise, not signal.
 * Filtering on noise manufactures a fake edge that evaporates out-of-sample
 * and, worse, switches off trading that was actually fine. So a cell is only
 * ever marked VETO when BOTH hold:
 *
 *   1. it has at least VETO_MIN_SAMPLE trades, and
 *   2. its mean per-trade P&L is negative by at least Z_VETO standard
 *      errors — i.e. we are ~95% confident the true expectancy is below
 *      zero, not just this sample.
 *
 * Everything else is WATCH (worth eyeballing, not enough evidence to act) or
 * KEEP. Symmetrically, a cell that is significantly POSITIVE is flagged
 * CONCENTRATE. Nothing here changes engine behavior — it is a pure,
 * read-only decomposition the harness verifies offline. Wiring an actual
 * veto into the decision path is a separate, opt-in, backtest-gated step,
 * deliberately NOT done until the data says a cell is real.
 */
import {
  type ForensicTradeRow, classifyTrade, realizedR,
} from "./edgeForensics";

/** A cell needs at least this many trades before it can be VETOed. */
export const VETO_MIN_SAMPLE = 20;
/** Below this, a negative cell is not even WATCH-worthy — pure noise. */
export const WATCH_MIN_SAMPLE = 8;
/** One-sided z: how many standard errors below zero the mean must sit to
 *  VETO (1.64 ≈ 95% one-sided confidence the true expectancy is negative). */
export const Z_VETO = 1.64;
/** Same bar for flagging a cell as significantly positive (CONCENTRATE). */
export const Z_CONCENTRATE = 1.64;

export type CellVerdict = "veto" | "watch" | "keep" | "concentrate";
export type CellDimension = "strategy" | "symbol" | "strategy_symbol" | "hour";

export interface SelectionCell {
  key: string;
  label: string;
  dimension: CellDimension;
  trades: number;
  wins: number;
  losses: number;
  scratches: number;
  totalPnl: number;
  /** Mean per-trade P&L in dollars, across ALL trades in the cell. */
  expectancy: number;
  /** Standard error of the mean (sd / √n); 0 when n < 2. */
  stdErr: number;
  /** −expectancy / stdErr: how many SEs below zero the mean sits. Positive =
   *  confidence the cell has NEGATIVE edge; negative = positive edge. */
  tStat: number;
  adjustedWinRate: number | null;
  avgR: number | null;
  verdict: CellVerdict;
}

export interface SelectionFilterReport {
  vetoMinSample: number;
  /** Every cell across all dimensions, worst expectancy first. */
  cells: SelectionCell[];
  vetoCandidates: SelectionCell[];
  watchCandidates: SelectionCell[];
  concentrateCandidates: SelectionCell[];
  /** What applying every VETO would have done historically (in-sample — a
   *  ceiling, not a promise). A trade counts as filtered if ANY of its cells
   *  is a veto, matching how a real filter would act. */
  projected: {
    vetoedTrades: number;
    /** Sum of P&L in filtered trades — negative = the bleed that would have
     *  been avoided; the account result improves by −this. */
    filteredPnl: number;
    /** Largest single cell (any dimension), so the UI can say how close the
     *  data is to being actionable when nothing is ready yet. */
    largestCellTrades: number;
  };
  /** True once at least one cell reaches VETO or CONCENTRATE — i.e. the data
   *  is finally thick enough to act on somewhere. */
  ready: boolean;
  summary: string;
}

interface Acc {
  label: string;
  dimension: CellDimension;
  pnls: number[];
  wins: number;
  losses: number;
  scratches: number;
  rSum: number;
  rCount: number;
}

function push(map: Map<string, Acc>, key: string, label: string, dimension: CellDimension, t: ForensicTradeRow, cls: string, r: number | null) {
  const a = map.get(key) ?? { label, dimension, pnls: [], wins: 0, losses: 0, scratches: 0, rSum: 0, rCount: 0 };
  a.pnls.push(t.pnl);
  if (cls === "win") a.wins++;
  else if (cls === "loss") a.losses++;
  else a.scratches++;
  if (r != null) { a.rSum += r; a.rCount++; }
  map.set(key, a);
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

/** Sample standard deviation (n−1). Returns 0 for n < 2. */
function stddev(xs: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const m = mean(xs);
  const v = xs.reduce((s, x) => s + (x - m) * (x - m), 0) / (n - 1);
  return Math.sqrt(v);
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10000) / 10000;

function toCell(key: string, a: Acc): SelectionCell {
  const trades = a.pnls.length;
  const expectancy = mean(a.pnls);
  const sd = stddev(a.pnls);
  const stdErr = trades >= 2 ? sd / Math.sqrt(trades) : 0;
  // tStat > 0 means the mean is BELOW zero (negative edge) — the sign is
  // flipped so a bigger positive tStat reads as "more confident it's bad".
  // Zero variance with n≥2 is perfect consistency (every trade the same):
  // maximally significant in whichever direction the mean sits, so it must
  // not collapse to tStat 0 (which would never veto the most consistent
  // loser of all). n<2 has no dispersion estimate → treat as inconclusive.
  const tStat =
    stdErr > 0 ? -expectancy / stdErr
    : trades >= 2 && expectancy !== 0 ? (expectancy < 0 ? Infinity : -Infinity)
    : 0;
  const decided = a.wins + a.losses;

  let verdict: CellVerdict;
  if (trades >= VETO_MIN_SAMPLE && expectancy < 0 && tStat >= Z_VETO) {
    verdict = "veto";
  } else if (trades >= VETO_MIN_SAMPLE && expectancy > 0 && -tStat >= Z_CONCENTRATE) {
    verdict = "concentrate";
  } else if (trades >= WATCH_MIN_SAMPLE && expectancy < 0) {
    verdict = "watch";
  } else {
    verdict = "keep";
  }

  return {
    key,
    label: a.label,
    dimension: a.dimension,
    trades,
    wins: a.wins,
    losses: a.losses,
    scratches: a.scratches,
    totalPnl: round2(a.pnls.reduce((s, x) => s + x, 0)),
    expectancy: round4(expectancy),
    stdErr: round4(stdErr),
    tStat: round2(tStat),
    adjustedWinRate: decided > 0 ? round4(a.wins / decided) : null,
    avgR: a.rCount > 0 ? round2(a.rSum / a.rCount) : null,
    verdict,
  };
}

export function analyzeSelection(rows: ForensicTradeRow[]): SelectionFilterReport {
  const byStrategy = new Map<string, Acc>();
  const bySymbol = new Map<string, Acc>();
  const byPair = new Map<string, Acc>();
  const byHour = new Map<string, Acc>();

  for (const t of rows) {
    const cls = classifyTrade(t);
    const r = realizedR(t);
    const strat = t.strategyId ?? "unknown";
    const stratLabel = t.strategyName ?? t.strategyId ?? "unknown";
    const hour = String(new Date(t.entryTimeMs).getUTCHours()).padStart(2, "0");
    push(byStrategy, strat, stratLabel, "strategy", t, cls, r);
    push(bySymbol, t.symbol, t.symbol, "symbol", t, cls, r);
    push(byPair, `${strat}|${t.symbol}`, `${stratLabel} · ${t.symbol}`, "strategy_symbol", t, cls, r);
    push(byHour, hour, `${hour}:00 UTC`, "hour", t, cls, r);
  }

  const cells: SelectionCell[] = [];
  for (const [map] of [[byStrategy], [bySymbol], [byPair], [byHour]] as const) {
    for (const [key, acc] of map) cells.push(toCell(key, acc));
  }
  cells.sort((a, b) => a.expectancy - b.expectancy); // worst edge first

  const vetoCandidates = cells.filter((c) => c.verdict === "veto");
  const watchCandidates = cells.filter((c) => c.verdict === "watch");
  const concentrateCandidates = cells.filter((c) => c.verdict === "concentrate");

  // Combined historical impact: a trade is filtered if it falls in ANY veto
  // cell (matching how a real filter would act). Reconstruct the veto key
  // sets and scan the rows once.
  const vetoStrategy = new Set(vetoCandidates.filter((c) => c.dimension === "strategy").map((c) => c.key));
  const vetoSymbol = new Set(vetoCandidates.filter((c) => c.dimension === "symbol").map((c) => c.key));
  const vetoPair = new Set(vetoCandidates.filter((c) => c.dimension === "strategy_symbol").map((c) => c.key));
  const vetoHour = new Set(vetoCandidates.filter((c) => c.dimension === "hour").map((c) => c.key));

  let vetoedTrades = 0;
  let filteredPnl = 0;
  for (const t of rows) {
    const strat = t.strategyId ?? "unknown";
    const hour = String(new Date(t.entryTimeMs).getUTCHours()).padStart(2, "0");
    const hit =
      vetoStrategy.has(strat) ||
      vetoSymbol.has(t.symbol) ||
      vetoPair.has(`${strat}|${t.symbol}`) ||
      vetoHour.has(hour);
    if (hit) { vetoedTrades++; filteredPnl += t.pnl; }
  }

  const largestCellTrades = cells.reduce((m, c) => Math.max(m, c.trades), 0);
  const ready = vetoCandidates.length > 0 || concentrateCandidates.length > 0;

  let summary: string;
  if (rows.length === 0) {
    summary = "No closed trades yet — the selection filter needs live history before it can say anything.";
  } else if (ready) {
    const bits: string[] = [];
    if (vetoCandidates.length) bits.push(`${vetoCandidates.length} cell(s) are confidently negative (VETO candidates)`);
    if (concentrateCandidates.length) bits.push(`${concentrateCandidates.length} confidently positive (CONCENTRATE)`);
    summary =
      `${bits.join("; ")}. Applying every veto would have removed ${vetoedTrades} trade(s) worth ` +
      `$${round2(filteredPnl)} historically (in-sample — validate with a backtest before trusting it).`;
  } else {
    summary =
      watchCandidates.length > 0
        ? `${watchCandidates.length} cell(s) are running negative but none has enough trades yet to act on with confidence ` +
          `(largest cell: ${largestCellTrades} trades; a veto needs ${VETO_MIN_SAMPLE}+ and statistical significance). Keep running.`
        : `Not enough live history to act on yet (largest cell: ${largestCellTrades} trades). Keep running.`;
  }

  return {
    vetoMinSample: VETO_MIN_SAMPLE,
    cells,
    vetoCandidates,
    watchCandidates,
    concentrateCandidates,
    projected: { vetoedTrades, filteredPnl: round2(filteredPnl), largestCellTrades },
    ready,
    summary,
  };
}
