/**
 * TradeCore Pro — portfolio-level risk math
 *
 * Everything here is PURE: no database, no exchange, no clock. The engine
 * gathers the inputs and applies the verdicts; this module only decides what
 * the numbers mean. That split is what makes these gates testable at all —
 * each one is a way real money escapes, and "we eyeballed it" is not a test.
 *
 * The gap this closes: the engine already caps a position COUNT
 * (maxOpenPositions), aggregate dollar RISK (maxPortfolioRiskPercent),
 * per-symbol NOTIONAL (maxSymbolConcentrationPercent) and NET direction
 * (maxNetExposurePercent). None of those notice that BTCUSDT and ETHUSDT are
 * very nearly the same bet. Five "independent" long positions across
 * correlated majors is one large position wearing a disguise, and it is
 * exactly the shape that turns a normal drawdown into an account-ending one.
 *
 * Deliberately NOT here: a hand-curated "sector" map (L1 / DeFi / meme, etc.).
 * Sector is a crude proxy for "these move together"; measured correlation is
 * the direct observation. A static map would need maintaining, would go stale
 * as assets re-rate, and would be wrong in precisely the regimes that matter —
 * when everything correlates to 1. Correlation subsumes it.
 */

/** Why a candidate was refused before any correlation work was paid for. */
export type SizingErrorCode =
  | "INSUFFICIENT_EQUITY"
  | "INVALID_STOP_DISTANCE"
  | "SIZE_ROUNDS_TO_ZERO"
  | "STALE_EQUITY"
  | "MISSING_FX_CONVERSION";

export interface SizingVerdict {
  ok: boolean;
  code?: SizingErrorCode;
  reason?: string;
}

export interface SizingInputs {
  balance: number;
  entryPrice: number;
  slPrice: number;
  qty: number;
  side: "long" | "short";
  /** Exchange step size for this symbol; qty below it cannot be submitted. */
  minQty?: number;
  /** Minimum account equity worth trading at all. */
  minEquity?: number;
  /** Age of the balance reading, in ms. Undefined = freshly read. */
  equityAgeMs?: number;
  /** Above this, the equity reading is too old to size against. */
  maxEquityAgeMs?: number;
  /**
   * Rate to convert this instrument's quote currency into the account
   * currency. 1 when they already match. `null` means we needed a rate and
   * did not have one — which must fail closed, never silently size as if the
   * rate were 1.
   */
  quoteToAccountRate?: number | null;
}

/**
 * The cheap gates, ordered cheapest-first. Every one of these is arithmetic on
 * values the engine already holds, so a candidate that fails here never pays
 * for the correlation computation below.
 */
export function validateSizing(i: SizingInputs): SizingVerdict {
  const minEquity = i.minEquity ?? 0;
  if (!Number.isFinite(i.balance) || i.balance <= 0 || i.balance < minEquity) {
    return {
      ok: false,
      code: "INSUFFICIENT_EQUITY",
      reason: `account equity $${Number(i.balance).toFixed(2)} is below the $${minEquity.toFixed(2)} minimum needed to size a position`,
    };
  }

  if (i.maxEquityAgeMs != null && i.equityAgeMs != null && i.equityAgeMs > i.maxEquityAgeMs) {
    return {
      ok: false,
      code: "STALE_EQUITY",
      reason: `balance reading is ${Math.round(i.equityAgeMs / 1000)}s old (max ${Math.round(i.maxEquityAgeMs / 1000)}s) — sizing against it could risk more than intended`,
    };
  }

  // A stop that is not strictly on the losing side of entry makes the
  // position's risk either zero or negative, which would sail through every
  // dollar-risk cap in the engine while being completely unprotected.
  const stopDistance = Math.abs(i.entryPrice - i.slPrice);
  const stopOnCorrectSide = i.side === "short" ? i.slPrice > i.entryPrice : i.slPrice < i.entryPrice;
  if (!Number.isFinite(stopDistance) || stopDistance <= 0 || !stopOnCorrectSide) {
    return {
      ok: false,
      code: "INVALID_STOP_DISTANCE",
      reason: `stop ${i.slPrice} is not a valid protective level for a ${i.side} entered at ${i.entryPrice}`,
    };
  }

  const minQty = i.minQty ?? 0;
  if (!Number.isFinite(i.qty) || i.qty <= 0 || i.qty < minQty) {
    return {
      ok: false,
      code: "SIZE_ROUNDS_TO_ZERO",
      reason: `computed size ${i.qty} rounds below the minimum tradable quantity ${minQty}`,
    };
  }

  if (i.quoteToAccountRate === null) {
    return {
      ok: false,
      code: "MISSING_FX_CONVERSION",
      reason: "no conversion rate available between this instrument's quote currency and the account currency — refusing to size as though it were 1:1",
    };
  }

  return { ok: true };
}

/** One daily close, timestamped. */
export interface DailyClose {
  /** ms since epoch, at the start of the day the candle covers. */
  timestamp: number;
  close: number;
}

const DAY_MS = 86_400_000;

/** UTC day index — the bucket two series must share to be comparable. */
function dayIndex(ms: number): number {
  return Math.floor(ms / DAY_MS);
}

/**
 * Daily log returns keyed by the day they END on.
 *
 * Returns are computed on each symbol's OWN consecutive candles, then keyed by
 * day — not by intersecting closes first. The difference matters for forex:
 * intersecting closes with 24/7 crypto and then differencing would silently
 * produce a "daily" return spanning a whole weekend for the forex leg, which
 * is a 3-day move being compared against a 1-day move. Keying afterwards means
 * every observation that survives is a genuine one-day return on both sides.
 */
export function dailyLogReturns(candles: DailyClose[]): Map<number, number> {
  const out = new Map<number, number>();
  const sorted = [...candles].sort((a, b) => a.timestamp - b.timestamp);
  for (let k = 1; k < sorted.length; k++) {
    const prev = sorted[k - 1]!;
    const cur = sorted[k]!;
    if (!(prev.close > 0) || !(cur.close > 0)) continue;
    // Only consecutive calendar days form a true one-day return.
    if (dayIndex(cur.timestamp) - dayIndex(prev.timestamp) !== 1) continue;
    out.set(dayIndex(cur.timestamp), Math.log(cur.close / prev.close));
  }
  return out;
}

export const MIN_CORRELATION_OBSERVATIONS = 20;

/**
 * Does this series vary enough to correlate at all? `sumSquares` is its
 * already-computed Σ(v − mean)². Scale-relative rather than absolute so the
 * answer does not depend on whether the values are returns (~0.01) or raw
 * prices (~10000).
 */
function isConstant(values: number[], sumSquares: number): boolean {
  if (!(sumSquares > 0)) return true;
  let scale = 0;
  for (const v of values) scale = Math.max(scale, Math.abs(v));
  if (scale === 0) return true;
  const rms = Math.sqrt(sumSquares / values.length);
  return rms < 1e-9 * scale;
}

/**
 * Pearson correlation over the days both series actually share.
 *
 * Returns `null` — never 0 — when there is not enough overlap or when either
 * series is flat. Zero would read as "measured, and they are unrelated", which
 * is the opposite of "we do not know", and the caller's policy for those two
 * cases is different.
 */
export function correlation(
  a: Map<number, number>,
  b: Map<number, number>,
  minObservations = MIN_CORRELATION_OBSERVATIONS,
): number | null {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [day, av] of a) {
    const bv = b.get(day);
    if (bv === undefined) continue;
    if (!Number.isFinite(av) || !Number.isFinite(bv)) continue;
    xs.push(av);
    ys.push(bv);
  }
  const n = xs.length;
  if (n < minObservations) return null;

  const meanX = xs.reduce((s, v) => s + v, 0) / n;
  const meanY = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let k = 0; k < n; k++) {
    const dx = xs[k]! - meanX;
    const dy = ys[k]! - meanY;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  // A constant series has no correlation to measure. Testing `dx2 <= 0` is
  // not enough: summing (v − mean) over identical values leaves floating-point
  // residue on the order of 1e-18, which is > 0 and would yield a meaningless
  // correlation manufactured entirely from rounding noise. Compare the RMS
  // deviation against the series' own magnitude instead, so the check holds
  // whether the data is priced in cents or in thousands.
  if (isConstant(xs, dx2) || isConstant(ys, dy2)) return null;
  const r = num / Math.sqrt(dx2 * dy2);
  // Guard the last bit of floating-point slop so callers can trust |r| <= 1.
  return Math.max(-1, Math.min(1, r));
}

export interface OpenExposure {
  symbol: string;
  side: "long" | "short";
  notionalUsdt: number;
}

export interface CorrelationInputs {
  candidate: { symbol: string; side: "long" | "short"; notionalUsdt: number };
  open: OpenExposure[];
  /** corr(candidate.symbol, openSymbol); null when unmeasurable. */
  correlations: Map<string, number | null>;
  balance: number;
  maxCorrelatedExposurePercent: number;
  /** |r| at or above this counts as "the same bet". */
  threshold: number;
  /** What to do about a pair whose correlation could not be measured. */
  unknownPolicy: "allow" | "block";
}

export interface CorrelationVerdict {
  ok: boolean;
  /** Candidate + every open position that reinforces it. */
  clusterNotionalUsdt: number;
  maxClusterNotionalUsdt: number;
  /** Symbols judged to be the same directional bet as the candidate. */
  clusterSymbols: string[];
  /** Pairs we could not measure — surfaced so the UI never implies certainty. */
  unmeasured: string[];
  reason?: string;
}

/**
 * Does taking this candidate build too large a single correlated bet?
 *
 * The direction test is the part worth reading twice. A position reinforces
 * the candidate when it expresses the SAME view, which is not the same as
 * "same side":
 *
 *   long BTC  + long ETH  (r ≈ +0.8)  → same bet
 *   short BTC + short ETH (r ≈ +0.8)  → same bet
 *   long BTC  + short ETH (r ≈ +0.8)  → a hedge, NOT additive
 *   long EUR_USD + short USD_CHF (r ≈ −0.9) → same bet, opposite sides
 *
 * So the signal is `r × (same side ? +1 : −1)`. Only a positive result at or
 * above the threshold is additive exposure.
 */
export function evaluateCorrelation(i: CorrelationInputs): CorrelationVerdict {
  const maxClusterNotionalUsdt = i.balance * (i.maxCorrelatedExposurePercent / 100);
  const clusterSymbols: string[] = [];
  const unmeasured: string[] = [];
  let clusterNotionalUsdt = i.candidate.notionalUsdt;

  for (const pos of i.open) {
    const r = i.correlations.get(pos.symbol);

    if (r == null) {
      unmeasured.push(pos.symbol);
      // An unmeasurable pair is a policy question, not a maths question. The
      // permissive default keeps a new account (which has no price history
      // yet) tradable; "block" is for someone who would rather not trade
      // blind.
      if (i.unknownPolicy === "block") {
        return {
          ok: false,
          clusterNotionalUsdt,
          maxClusterNotionalUsdt,
          clusterSymbols,
          unmeasured,
          reason: `correlation between ${i.candidate.symbol} and open position ${pos.symbol} could not be measured, and policy is to block rather than trade blind`,
        };
      }
      continue;
    }

    const sameSide = pos.side === i.candidate.side;
    const reinforcement = r * (sameSide ? 1 : -1);
    if (reinforcement >= i.threshold) {
      clusterSymbols.push(pos.symbol);
      clusterNotionalUsdt += pos.notionalUsdt;
    }
  }

  const ok = clusterNotionalUsdt <= maxClusterNotionalUsdt;
  return {
    ok,
    clusterNotionalUsdt,
    maxClusterNotionalUsdt,
    clusterSymbols,
    unmeasured,
    ...(ok ? {} : {
      reason: `correlated exposure $${clusterNotionalUsdt.toFixed(2)} across ${[i.candidate.symbol, ...clusterSymbols].join(", ")} would exceed the $${maxClusterNotionalUsdt.toFixed(2)} cap`,
    }),
  };
}

/** One cell of the correlation heat map. */
export interface HeatMapCell {
  a: string;
  b: string;
  /** null = not enough shared history to measure. */
  correlation: number | null;
}

/**
 * Full pairwise matrix for the dashboard, upper triangle only (corr is
 * symmetric and the diagonal is trivially 1). Cells that cannot be measured
 * stay null so the UI renders "insufficient history" rather than a number.
 */
export function buildHeatMap(
  returnsBySymbol: Map<string, Map<number, number>>,
  minObservations = MIN_CORRELATION_OBSERVATIONS,
): HeatMapCell[] {
  const symbols = [...returnsBySymbol.keys()].sort();
  const cells: HeatMapCell[] = [];
  for (let x = 0; x < symbols.length; x++) {
    for (let y = x + 1; y < symbols.length; y++) {
      const a = symbols[x]!;
      const b = symbols[y]!;
      cells.push({
        a,
        b,
        correlation: correlation(returnsBySymbol.get(a)!, returnsBySymbol.get(b)!, minObservations),
      });
    }
  }
  return cells;
}
