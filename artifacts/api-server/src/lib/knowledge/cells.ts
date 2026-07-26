/**
 * TradeCore Pro — market knowledge cells
 *
 * "Where does this account actually have an edge?" answered by slicing closed
 * trades along the four dimensions that plausibly carry one — strategy in a
 * regime, symbol under a strategy, time of day, and volatility state — and
 * refusing to answer for any slice too thin to support the answer.
 *
 * The three rules that make this an asset rather than a plausible-looking
 * number generator:
 *
 *  1. BELOW THE GATE, NULL. A cell with fewer than `MIN_CELL_SAMPLES` closed
 *     trades reports its sample count and nothing else. Not a provisional
 *     figure, not a greyed-out one — null, so there is no number on the screen
 *     to anchor on. Counts are facts and are always shown; rates are estimates
 *     and are earned.
 *
 *  2. ABOVE THE GATE, STILL NOT A DISCOVERY. Passing the gate buys a measured
 *     win rate, not a claim of edge. Whether a cell differs from the account's
 *     own baseline is a separate question answered by an exact binomial test
 *     with a Benjamini–Hochberg correction across every cell tested (stats.ts).
 *
 *  3. NOTHING HERE TOUCHES A DECISION. This is a read model. The scan loop
 *     does not import it, no strategy sees it, and no confidence score moves
 *     because of it — which is why the whole phase is harness-Δ0 by
 *     construction. Letting knowledge influence trading is a later, gated,
 *     off-by-default phase with its own validation requirement.
 */
import {
  classifyOutcome, expectancyPerTrade, profitFactor, realizedR,
  winRateOrNull, round2, round4, type TradeOutcome,
} from "../metrics/kernel";
import { benjaminiHochberg, binomialTest, wilsonInterval, DEFAULT_FDR, type Tested } from "./stats";
import type { Observable, PointInTimeView } from "./pointInTime";

/**
 * The floor for reporting any rate at all.
 *
 * 30 is the conventional small-sample threshold, and it is chosen here for a
 * concrete reason rather than tradition: at n = 30 the 95% Wilson interval on
 * a 50% win rate still spans roughly 33%–67%. That is already a wide enough
 * band to keep a reader honest. Below it the interval covers nearly the whole
 * unit line and the point estimate is decoration.
 */
export const MIN_CELL_SAMPLES = 30;

export type CellDimension =
  | "strategy_regime"
  | "symbol_strategy"
  | "session"
  | "volatility";

/** UTC trading sessions. Crypto never closes, but participation still cycles. */
export type Session = "asian" | "london" | "new_york" | "off_hours";

/** Coarse volatility state at entry, from ATR as a percentage of price. */
export type VolatilityBucket = "low" | "normal" | "high";

/**
 * Session boundaries in UTC hours, [start, end).
 *
 * Deliberately fixed rather than DST-adjusted. These are labels for "which
 * part of the day", and a boundary that shifts twice a year would silently
 * reclassify historical trades — the same trade landing in a different cell
 * depending on when you asked. A stable, slightly-wrong boundary beats an
 * accurate one that rewrites the past.
 */
export const SESSION_BOUNDS: Record<Exclude<Session, "off_hours">, [number, number]> = {
  asian: [0, 7],
  london: [7, 13],
  new_york: [13, 21],
};

/** ATR% cut points. Below `low`, low; at or above `high`, high; between, normal. */
export const VOLATILITY_BOUNDS = { low: 0.5, high: 1.5 };

export function sessionOf(entryTimeMs: number): Session {
  const hour = new Date(entryTimeMs).getUTCHours();
  for (const [name, [start, end]] of Object.entries(SESSION_BOUNDS)) {
    if (hour >= start && hour < end) return name as Session;
  }
  return "off_hours";
}

export function volatilityBucketOf(atrPercent: number | null): VolatilityBucket | null {
  if (atrPercent == null || !Number.isFinite(atrPercent)) return null;
  if (atrPercent < VOLATILITY_BOUNDS.low) return "low";
  if (atrPercent >= VOLATILITY_BOUNDS.high) return "high";
  return "normal";
}

/**
 * One closed trade, reduced to what the knowledge layer needs.
 *
 * `closedAt` satisfies `Observable`, so these can only reach the aggregator
 * through a point-in-time view.
 */
export interface TradeObservation extends Observable {
  readonly closedAt: number;
  readonly entryTime: number;
  readonly tradeId: number;
  readonly symbol: string;
  /** Null on trades opened before strategies were attributed. Such a trade
   *  still counts in the session and volatility cells; it is simply absent
   *  from the two strategy dimensions rather than filed under "unknown". */
  readonly strategyId: string | null;
  readonly regime: string | null;
  /** ATR% at entry, when the feature snapshot recorded it. */
  readonly atrPercent: number | null;
  /** Net P&L in account currency. */
  readonly pnl: number;
  /** Planned dollar risk (|entry − stop| × qty) — the denominator for R. */
  readonly plannedRisk: number | null;
  readonly exitReason: string | null;
  /** Strategy confidence 0–100 at entry, for the calibration set. */
  readonly confidence: number | null;
  /**
   * Indicator readings at entry, from the captured feature snapshot. Null on
   * trades that predate capture (P2) or were seeded — those still count toward
   * every cell, and are simply absent from the similarity pool. Typed loosely
   * here so cells.ts stays free of a dependency on similarity.ts.
   */
  readonly features: Readonly<Record<string, number>> | null;
}

export interface CellStats {
  /** Always present — a count is a fact, not an estimate. */
  samples: number;
  wins: number;
  losses: number;
  scratches: number;
  /** True when `samples < minSamples`; every field below is then null. */
  gated: boolean;
  minSamples: number;

  /** Scratch-adjusted: wins / (wins + losses), excluding washes. */
  winRate: number | null;
  /** 95% Wilson interval on `winRate` — the honesty band around the estimate. */
  winRateLow: number | null;
  winRateHigh: number | null;
  expectancyUsdt: number | null;
  profitFactor: number | null;
  avgR: number | null;
  /** Sum of P&L. A fact like the counts, so it survives the gate. */
  netPnlUsdt: number;
}

export interface KnowledgeCell extends CellStats {
  dimension: CellDimension;
  /** Stable machine key, e.g. "momentum|trending_up". */
  key: string;
  /** Human label for the UI, e.g. "Momentum · Trending up". */
  label: string;
  /**
   * Null when the cell is gated, or when it passed the gate but the family had
   * nothing to compare against. `significant` means: this cell's win rate
   * differs from the account baseline by more than multiple testing explains.
   */
  significance: { pValue: number; qValue: number; significant: boolean } | null;
}

function emptyStats(minSamples: number): CellStats {
  return {
    samples: 0, wins: 0, losses: 0, scratches: 0,
    gated: true, minSamples,
    winRate: null, winRateLow: null, winRateHigh: null,
    expectancyUsdt: null, profitFactor: null, avgR: null,
    netPnlUsdt: 0,
  };
}

/**
 * Aggregate one bucket of trades.
 *
 * Every metric routes through the P0 kernel, so a win rate here means exactly
 * what a win rate means in Edge Forensics — the scratch-adjusted definition,
 * which excludes break-even washes from the denominator rather than counting
 * them as losses.
 */
export function summarise(trades: readonly TradeObservation[], minSamples = MIN_CELL_SAMPLES): CellStats {
  const stats = emptyStats(minSamples);
  stats.samples = trades.length;
  if (trades.length === 0) return stats;

  let grossProfit = 0;
  let grossLoss = 0;
  let rSum = 0;
  let rCount = 0;

  for (const t of trades) {
    const outcome: TradeOutcome = classifyOutcome(t.pnl, t.plannedRisk, t.exitReason);
    if (outcome === "win") stats.wins++;
    else if (outcome === "loss") stats.losses++;
    else stats.scratches++;

    stats.netPnlUsdt += t.pnl;
    if (t.pnl > 0) grossProfit += t.pnl;
    else grossLoss += Math.abs(t.pnl);

    const r = realizedR(t.pnl, t.plannedRisk);
    if (r != null) { rSum += r; rCount++; }
  }

  stats.netPnlUsdt = round2(stats.netPnlUsdt);
  stats.gated = trades.length < minSamples;
  if (stats.gated) return stats;

  const decided = stats.wins + stats.losses;
  const wr = winRateOrNull(stats.wins, decided);
  const interval = wilsonInterval(stats.wins, decided);

  stats.winRate = wr == null ? null : round4(wr);
  stats.winRateLow = interval ? round4(interval.low) : null;
  stats.winRateHigh = interval ? round4(interval.high) : null;
  stats.expectancyUsdt = round2(expectancyPerTrade(
    trades.reduce((s, t) => s + t.pnl, 0), trades.length,
  ));
  stats.profitFactor = round2(profitFactor(grossProfit, grossLoss));
  stats.avgR = rCount > 0 ? round4(rSum / rCount) : null;

  return stats;
}

const REGIME_LABELS: Record<string, string> = {
  trending_up: "Trending up",
  trending_down: "Trending down",
  ranging: "Ranging",
  high_volatility: "High volatility",
  low_volatility: "Low volatility",
};

const SESSION_LABELS: Record<Session, string> = {
  asian: "Asian session",
  london: "London session",
  new_york: "New York session",
  off_hours: "Off hours",
};

const VOLATILITY_LABELS: Record<VolatilityBucket, string> = {
  low: "Low volatility (ATR < 0.5%)",
  normal: "Normal volatility (ATR 0.5–1.5%)",
  high: "High volatility (ATR ≥ 1.5%)",
};

const titleCase = (s: string) => s.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * Bucket a trade along one dimension. Returns null when the trade lacks the
 * facts that dimension needs — a trade with no recorded regime is absent from
 * the regime breakdown rather than filed under "unknown", which would become a
 * cell in its own right and eventually get tested for significance.
 */
function keyFor(dim: CellDimension, t: TradeObservation): { key: string; label: string } | null {
  switch (dim) {
    case "strategy_regime": {
      if (!t.regime || !t.strategyId) return null;
      return {
        key: `${t.strategyId}|${t.regime}`,
        label: `${titleCase(t.strategyId)} · ${REGIME_LABELS[t.regime] ?? titleCase(t.regime)}`,
      };
    }
    case "symbol_strategy":
      if (!t.strategyId) return null;
      return { key: `${t.symbol}|${t.strategyId}`, label: `${t.symbol} · ${titleCase(t.strategyId)}` };
    case "session": {
      const s = sessionOf(t.entryTime);
      return { key: s, label: SESSION_LABELS[s] };
    }
    case "volatility": {
      const v = volatilityBucketOf(t.atrPercent);
      if (!v) return null;
      return { key: v, label: VOLATILITY_LABELS[v] };
    }
  }
}

export const ALL_DIMENSIONS: readonly CellDimension[] = [
  "strategy_regime", "symbol_strategy", "session", "volatility",
];

export interface CellsOptions {
  minSamples?: number;
  /** False-discovery rate budget for the significance family. */
  fdr?: number;
  dimensions?: readonly CellDimension[];
}

export interface KnowledgeReport {
  /** The cut these cells were computed at — every claim is as of this moment. */
  asOf: number;
  /** Closed trades available at the cut. */
  totalTrades: number;
  /**
   * The account's own scratch-adjusted win rate, the null hypothesis each cell
   * is tested against. Null below the gate — with no trustworthy baseline
   * there is nothing to test against, and every cell's significance is null.
   */
  baselineWinRate: number | null;
  minSamples: number;
  fdr: number;
  /** How many cells entered the multiple-comparison family. */
  cellsTested: number;
  cells: KnowledgeCell[];
}

/**
 * Build every cell across every dimension, gate them, and test the survivors
 * as one family.
 *
 * Cells are returned for gated buckets too. An empty screen cannot distinguish
 * "no edge here" from "not enough data yet", and the second is the true and
 * far more useful statement for a young account.
 */
export function buildKnowledge(
  view: PointInTimeView<TradeObservation>,
  opts: CellsOptions = {},
): KnowledgeReport {
  const minSamples = opts.minSamples ?? MIN_CELL_SAMPLES;
  const fdr = opts.fdr ?? DEFAULT_FDR;
  const dimensions = opts.dimensions ?? ALL_DIMENSIONS;

  const overall = summarise(view.rows, minSamples);
  const baselineWinRate = overall.winRate;

  const cells: KnowledgeCell[] = [];
  const family: Tested<KnowledgeCell>[] = [];

  for (const dimension of dimensions) {
    const buckets = new Map<string, { label: string; trades: TradeObservation[] }>();
    for (const t of view.rows) {
      const k = keyFor(dimension, t);
      if (!k) continue;
      let bucket = buckets.get(k.key);
      if (!bucket) { bucket = { label: k.label, trades: [] }; buckets.set(k.key, bucket); }
      bucket.trades.push(t);
    }

    for (const [key, bucket] of buckets) {
      const stats = summarise(bucket.trades, minSamples);
      const cell: KnowledgeCell = { dimension, key, label: bucket.label, ...stats, significance: null };
      cells.push(cell);

      // Only ungated cells are tested, and only when there is a baseline to
      // test against. A cell that IS essentially the whole account (the sole
      // strategy, say) would trivially match the baseline; that is a true and
      // uninteresting result, not a special case worth excluding.
      if (!stats.gated && baselineWinRate != null) {
        const decided = stats.wins + stats.losses;
        family.push({ item: cell, pValue: binomialTest(stats.wins, decided, baselineWinRate) });
      }
    }
  }

  for (const adjusted of benjaminiHochberg(family, fdr)) {
    adjusted.item.significance = {
      pValue: round4(adjusted.pValue),
      qValue: round4(adjusted.qValue),
      significant: adjusted.significant,
    };
  }

  // Strongest evidence first, then largest sample — a stable order that puts
  // the cells a reader should act on at the top, and never buries a
  // well-evidenced cell under a lucky thin one.
  cells.sort((a, b) => {
    const aq = a.significance?.qValue ?? Number.POSITIVE_INFINITY;
    const bq = b.significance?.qValue ?? Number.POSITIVE_INFINITY;
    if (aq !== bq) return aq - bq;
    return b.samples - a.samples;
  });

  return {
    asOf: view.asOf,
    totalTrades: view.rows.length,
    baselineWinRate,
    minSamples,
    fdr,
    cellsTested: family.length,
    cells,
  };
}
