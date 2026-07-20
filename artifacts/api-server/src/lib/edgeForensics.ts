/**
 * TradeCore Pro — Edge Forensics
 *
 * Answers ONE question with the user's own closed trades: WHERE does the
 * losing come from? A raw "10% win rate" is a symptom, not a diagnosis —
 * this module decomposes it into named, dollar-quantified leaks:
 *
 *   - SCRATCHES MISCOUNTED AS LOSSES: break-even exits (stop moved to entry
 *     after TP1) close a few cents red after fees and land in the "losses"
 *     column, cratering the win-rate stat while barely touching P&L. The
 *     adjusted win rate (wins / decided trades, scratches excluded) is the
 *     honest number.
 *   - EXIT-MECHANIC BLEEDS: which exit reason actually loses the money
 *     (noise-stopped stop_losses, drifting timeouts, …).
 *   - NEGATIVE CELLS: strategies / symbols / entry hours with measurably
 *     negative expectancy — the raw material for selection edge ("stop
 *     trading where you lose") in the next step.
 *   - R-MULTIPLE SHAPE: how realized losses compare to planned risk.
 *
 * Pure aggregation — no DB, no engine — so the harness can verify every
 * classification rule offline. The route (routes/reports.ts) feeds it real
 * rows and adds the live noise-floor audit on top.
 */

/** The subset of a closed trades row this analysis needs. */
export interface ForensicTradeRow {
  pnl: number;
  grossPnl: number | null;
  feesUsdt: number | null;
  entryPrice: number;
  /** Stop as the plan intended it (pre-BE-move); falls back to stopLoss. */
  plannedStopLoss: number | null;
  stopLoss: number;
  plannedQuantity: number | null;
  quantity: number;
  exitReason: string | null;
  strategyId: string | null;
  strategyName: string | null;
  symbol: string;
  /** Entry time epoch ms — losses are bucketed by ENTRY hour (UTC), the
   *  hour the decision was made, which is the hour a filter could act on. */
  entryTimeMs: number;
  holdingSeconds: number | null;
  tp1Filled: boolean;
}

export type TradeClass = "win" | "loss" | "scratch";

export interface ForensicCell {
  key: string;
  label: string;
  trades: number;
  wins: number;
  losses: number;
  scratches: number;
  totalPnl: number;
  /** wins / (trades - scratches); null when nothing was decided. */
  adjustedWinRate: number | null;
  avgPnl: number;
  /** Mean realized R-multiple across trades with a measurable planned risk. */
  avgR: number | null;
}

export interface ForensicVerdict {
  severity: "critical" | "warning" | "info";
  title: string;
  detail: string;
}

export interface EdgeForensicsReport {
  totalTrades: number;
  wins: number;
  losses: number;
  scratches: number;
  rawWinRate: number | null;
  adjustedWinRate: number | null;
  totalPnl: number;
  totalFees: number;
  grossPnl: number;
  avgWin: number | null;
  avgLoss: number | null;
  /** Expectancy per decided trade (scratches excluded), in dollars. */
  expectancyPerTrade: number | null;
  byExitReason: ForensicCell[];
  byStrategy: ForensicCell[];
  bySymbol: ForensicCell[];
  byHourUtc: ForensicCell[];
  rDistribution: Array<{ bucket: string; count: number }>;
  verdicts: ForensicVerdict[];
}

/** A trade is a SCRATCH when it exited at the moved-to-break-even stop, or
 *  when its net P&L is inside ±10% of the planned dollar risk — a wash,
 *  not a decision the market made about the thesis. */
export function classifyTrade(t: ForensicTradeRow): TradeClass {
  if (t.exitReason === "break_even") return "scratch";
  const risk = plannedRiskDollars(t);
  if (risk != null && risk > 0 && Math.abs(t.pnl) < 0.1 * risk) return "scratch";
  if (t.pnl > 0) return "win";
  return "loss";
}

/** Planned dollar risk = |entry − planned stop| × planned qty (falls back to
 *  actual stop/qty). Null when the stop distance is degenerate. */
export function plannedRiskDollars(t: ForensicTradeRow): number | null {
  const stop = t.plannedStopLoss ?? t.stopLoss;
  const qty = t.plannedQuantity ?? t.quantity;
  const dist = Math.abs(t.entryPrice - stop);
  if (!(dist > 0) || !(qty > 0)) return null;
  return dist * qty;
}

export function realizedR(t: ForensicTradeRow): number | null {
  const risk = plannedRiskDollars(t);
  if (risk == null || !(risk > 0)) return null;
  return t.pnl / risk;
}

interface CellAcc {
  label: string;
  trades: number; wins: number; losses: number; scratches: number;
  totalPnl: number; rSum: number; rCount: number;
}

function newAcc(label: string): CellAcc {
  return { label, trades: 0, wins: 0, losses: 0, scratches: 0, totalPnl: 0, rSum: 0, rCount: 0 };
}

function finishCells(map: Map<string, CellAcc>): ForensicCell[] {
  return [...map.entries()]
    .map(([key, a]) => {
      const decided = a.trades - a.scratches;
      return {
        key,
        label: a.label,
        trades: a.trades,
        wins: a.wins,
        losses: a.losses,
        scratches: a.scratches,
        totalPnl: round2(a.totalPnl),
        adjustedWinRate: decided > 0 ? round4(a.wins / decided) : null,
        avgPnl: round4(a.trades > 0 ? a.totalPnl / a.trades : 0),
        avgR: a.rCount > 0 ? round2(a.rSum / a.rCount) : null,
      };
    })
    .sort((x, y) => x.totalPnl - y.totalPnl); // most-bleeding first
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10000) / 10000;

export function analyzeEdge(rows: ForensicTradeRow[]): EdgeForensicsReport {
  const byExit = new Map<string, CellAcc>();
  const byStrategy = new Map<string, CellAcc>();
  const bySymbol = new Map<string, CellAcc>();
  const byHour = new Map<string, CellAcc>();
  const rBuckets = new Map<string, number>();

  let wins = 0, losses = 0, scratches = 0;
  let totalPnl = 0, totalFees = 0, grossPnl = 0;
  let winPnl = 0, lossPnl = 0;

  for (const t of rows) {
    const cls = classifyTrade(t);
    if (cls === "win") { wins++; winPnl += t.pnl; }
    else if (cls === "loss") { losses++; lossPnl += t.pnl; }
    else scratches++;
    totalPnl += t.pnl;
    totalFees += t.feesUsdt ?? 0;
    grossPnl += t.grossPnl ?? t.pnl;

    const r = realizedR(t);
    if (r != null) {
      const bucket =
        r <= -1.5 ? "≤ -1.5R" :
        r <= -1.05 ? "-1.5..-1R" :
        r <= -0.5 ? "-1..-0.5R" :
        r < -0.1 ? "-0.5..-0.1R" :
        r <= 0.1 ? "-0.1..0.1R (scratch band)" :
        r <= 0.5 ? "0.1..0.5R" :
        r <= 1 ? "0.5..1R" :
        r <= 2 ? "1..2R" : "> 2R";
      rBuckets.set(bucket, (rBuckets.get(bucket) ?? 0) + 1);
    }

    const touch = (map: Map<string, CellAcc>, key: string, label: string) => {
      const acc = map.get(key) ?? newAcc(label);
      acc.trades++;
      if (cls === "win") acc.wins++;
      else if (cls === "loss") acc.losses++;
      else acc.scratches++;
      acc.totalPnl += t.pnl;
      if (r != null) { acc.rSum += r; acc.rCount++; }
      map.set(key, acc);
    };

    touch(byExit, t.exitReason ?? "unknown", t.exitReason ?? "unknown");
    touch(byStrategy, t.strategyId ?? "unknown", t.strategyName ?? t.strategyId ?? "unknown");
    touch(bySymbol, t.symbol, t.symbol);
    const hour = new Date(t.entryTimeMs).getUTCHours();
    touch(byHour, String(hour).padStart(2, "0"), `${String(hour).padStart(2, "0")}:00 UTC`);
  }

  const total = rows.length;
  const decided = total - scratches;

  // ── Verdicts: the named leaks, most damning first ─────────────────────────
  const verdicts: ForensicVerdict[] = [];

  if (total === 0) {
    verdicts.push({ severity: "info", title: "No closed trades yet", detail: "The forensics need at least a handful of closed live trades to say anything." });
  } else {
    const rawWr = wins / total;
    const adjWr = decided > 0 ? wins / decided : null;
    if (adjWr != null && scratches / total >= 0.15 && adjWr - rawWr >= 0.05) {
      verdicts.push({
        severity: "critical",
        title: `${Math.round((scratches / total) * 100)}% of "losses" are scratches, not losses`,
        detail:
          `${scratches} of ${total} trades exited at (or within 10% of risk around) break-even — the win-rate stat counts them as losses. ` +
          `Raw win rate ${(rawWr * 100).toFixed(0)}% → ${(adjWr * 100).toFixed(0)}% once scratches are excluded. ` +
          `The engine is scratching far more than it is being beaten.`,
      });
    }

    const exitCells = finishCells(byExit);
    const worstExit = exitCells[0];
    if (worstExit && worstExit.totalPnl < 0 && Math.abs(worstExit.totalPnl) >= Math.abs(totalPnl) * 0.4 && worstExit.losses >= 5) {
      verdicts.push({
        severity: "critical",
        title: `"${worstExit.label}" exits are the biggest bleed: $${worstExit.totalPnl.toFixed(2)}`,
        detail:
          worstExit.key === "stop_loss"
            ? `${worstExit.losses} stop-loss exits. If their average R is ≈ −1 and they fire fast, stops are sitting inside market noise — widen the stop floor or cut size.`
            : worstExit.key === "timeout"
              ? `${worstExit.losses} timeout exits — targets are not being reached inside the hold window, so trades die at drift-plus-fees. Targets and hold windows disagree.`
              : `${worstExit.trades} trades exited via ${worstExit.label} for a net $${worstExit.totalPnl.toFixed(2)}.`,
      });
    }

    const fastLosses = rows.filter((t) => classifyTrade(t) === "loss" && t.exitReason === "stop_loss" && (t.holdingSeconds ?? Infinity) < 300);
    if (fastLosses.length >= 5 && losses > 0 && fastLosses.length / losses >= 0.3) {
      verdicts.push({
        severity: "critical",
        title: `${fastLosses.length} stop-outs in under 5 minutes (${Math.round((fastLosses.length / losses) * 100)}% of losses)`,
        detail: "Stops that die this fast are inside ordinary candle noise — the thesis never got to run. The stop floor needs to clear the symbol's short-term ATR.",
      });
    }

    if (totalFees > 0 && grossPnl > totalPnl && totalFees >= Math.abs(totalPnl) * 0.5 && total >= 20) {
      verdicts.push({
        severity: "warning",
        title: `$${totalFees.toFixed(2)} paid in fees vs $${totalPnl.toFixed(2)} net P&L`,
        detail: "Costs are a first-order driver of the result — fewer, larger, higher-conviction trades keep more of the gross.",
      });
    }

    for (const [cells, noun] of [[finishCells(byStrategy), "strategy"], [finishCells(bySymbol), "symbol"], [finishCells(byHour), "entry hour"]] as const) {
      const worst = cells.filter((c) => c.trades >= 5 && c.totalPnl < 0).slice(0, 2);
      for (const c of worst) {
        verdicts.push({
          severity: "warning",
          title: `Negative ${noun}: ${c.label} — $${c.totalPnl.toFixed(2)} over ${c.trades} trades`,
          detail: `Adjusted win rate ${(c.adjustedWinRate != null ? c.adjustedWinRate * 100 : 0).toFixed(0)}%${c.avgR != null ? `, avg ${c.avgR}R` : ""}. A candidate for the selection filter (stop trading where you measurably lose).`,
        });
      }
    }

    const positives = finishCells(byStrategy).filter((c) => c.trades >= 5 && c.totalPnl > 0);
    if (positives.length > 0) {
      const best = positives[positives.length - 1]!;
      verdicts.push({
        severity: "info",
        title: `Where you actually WIN: ${best.label} (+$${best.totalPnl.toFixed(2)} over ${best.trades} trades)`,
        detail: "Selection edge means concentrating capital here while the negative cells above are filtered out.",
      });
    }
  }

  return {
    totalTrades: total,
    wins, losses, scratches,
    rawWinRate: total > 0 ? round4(wins / total) : null,
    adjustedWinRate: decided > 0 ? round4(wins / decided) : null,
    totalPnl: round2(totalPnl),
    totalFees: round2(totalFees),
    grossPnl: round2(grossPnl),
    avgWin: wins > 0 ? round2(winPnl / wins) : null,
    avgLoss: losses > 0 ? round2(lossPnl / losses) : null,
    expectancyPerTrade: decided > 0 ? round4((winPnl + lossPnl) / decided) : null,
    byExitReason: finishCells(byExit),
    byStrategy: finishCells(byStrategy),
    bySymbol: finishCells(bySymbol),
    byHourUtc: finishCells(byHour),
    rDistribution: [...rBuckets.entries()].map(([bucket, count]) => ({ bucket, count })),
    verdicts,
  };
}
