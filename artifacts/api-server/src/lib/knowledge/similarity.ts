/**
 * TradeCore Pro — similar historical trades
 *
 * "The last time the book looked like this, here is what happened." Shown on
 * the Co-Pilot workspace next to a live recommendation, which is exactly why
 * every shortcut in the obvious implementation is unacceptable:
 *
 *  1. RAW COSINE IS MEANINGLESS HERE. The feature vector mixes RSI (0–100),
 *     ADX (0–100), ATR% (~0.1–3) and volume ratio (~0.5–4). Un-normalised,
 *     the two 0–100 features dominate the dot product and the "most similar"
 *     trade is whichever had a comparable RSI, regardless of everything else.
 *     Every vector is z-scored against the pool first, so similarity measures
 *     agreement in how UNUSUAL each reading was — the thing a trader means.
 *
 *  2. TOP-N IS NOT SIMILARITY. Slicing the 50 nearest neighbours always
 *     returns 50 rows, so an account with nine unrelated trades gets nine
 *     confident "similar setups". A floor comes first; the cap only bounds
 *     what survives it. Nothing similar means nothing shown.
 *
 *  3. A SMALL POOL CANNOT BE NORMALISED. Means and standard deviations from a
 *     handful of trades are noise, and dividing by a noisy sd manufactures
 *     large deviations out of nothing. Below the pool gate the feature is
 *     unavailable, with a reason — never a thin answer.
 *
 * Aggregate outcome stats over the matches route through the same kernel
 * summariser the knowledge cells use, so "win rate" means the identical thing
 * on both screens.
 */
import { round4 } from "../metrics/kernel";
import { classifyOutcome, realizedR } from "../metrics/kernel";
import { summarise, type CellStats, type TradeObservation } from "./cells";
import type { PointInTimeView } from "./pointInTime";

/**
 * The comparison axes.
 *
 * Deliberately small and all continuous. Every added dimension dilutes cosine
 * similarity (the curse of dimensionality is brutal at these sample sizes),
 * and booleans z-score into two spikes that behave badly under interpolation.
 */
export const FEATURE_KEYS = [
  "confidence", "rsi", "adx", "atrPercent", "volumeRatio", "macdHistogram",
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];
export type FeatureVector = Readonly<Partial<Record<FeatureKey, number>>>;

/**
 * Minimum pool before z-scores are trustworthy enough to normalise with.
 * Same 30 as the cell gate, for the same reason.
 */
export const MIN_POOL_SIZE = 30;

/**
 * Cosine floor on z-scored vectors.
 *
 * 0.7 is not arbitrary: on standardised vectors, cosine is the correlation
 * between the two setups' deviation profiles, so 0.7 is the same "strongly
 * related" line the P6 correlation gate uses. Keeping one threshold meaning
 * one thing across the product is worth more than tuning each in isolation.
 */
export const SIMILARITY_FLOOR = 0.7;

/** Matches needed before aggregate outcome stats are reported. */
export const MIN_MATCHES_FOR_STATS = 10;

/** Hard cap on returned neighbours, after the floor. */
export const MAX_MATCHES = 50;

export interface NormalisationStats {
  /** Per-feature mean and standard deviation over the pool. */
  readonly mean: Partial<Record<FeatureKey, number>>;
  readonly sd: Partial<Record<FeatureKey, number>>;
  /** Features with non-zero variance — the axes actually used. */
  readonly usable: FeatureKey[];
}

/**
 * Population mean and sd per feature.
 *
 * A feature present on fewer than half the pool's trades is excluded: an axis
 * measured on a minority of the record would be compared against imputed
 * values for everyone else, which is fabrication with extra steps.
 */
export function normalisationStats(vectors: readonly FeatureVector[]): NormalisationStats {
  const mean: Partial<Record<FeatureKey, number>> = {};
  const sd: Partial<Record<FeatureKey, number>> = {};
  const usable: FeatureKey[] = [];

  for (const key of FEATURE_KEYS) {
    const values = vectors
      .map((v) => v[key])
      .filter((n): n is number => typeof n === "number" && Number.isFinite(n));
    if (values.length < Math.max(2, vectors.length / 2)) continue;

    const m = values.reduce((s, n) => s + n, 0) / values.length;
    const variance = values.reduce((s, n) => s + (n - m) ** 2, 0) / values.length;
    const s = Math.sqrt(variance);
    mean[key] = m;
    sd[key] = s;
    // A constant feature carries no information about similarity, and its
    // z-score is 0/0. Dropped rather than epsilon-guarded.
    if (s > 1e-9) usable.push(key);
  }

  return { mean, sd, usable };
}

/** z-score a vector onto the usable axes. Missing values become 0 — the mean. */
export function standardise(vector: FeatureVector, stats: NormalisationStats): number[] {
  return stats.usable.map((key) => {
    const raw = vector[key];
    if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
    return (raw - stats.mean[key]!) / stats.sd[key]!;
  });
}

/** Cosine similarity. Returns null when either vector is at the origin. */
export function cosine(a: readonly number[], b: readonly number[]): number | null {
  if (a.length !== b.length || a.length === 0) return null;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! ** 2;
    nb += b[i]! ** 2;
  }
  if (na <= 1e-12 || nb <= 1e-12) return null;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface SimilarMatch {
  tradeId: number;
  symbol: string;
  strategyId: string | null;
  closedAt: number;
  /** Cosine on standardised vectors, in [-1, 1]. */
  similarity: number;
  pnl: number;
  rMultiple: number | null;
  outcome: "win" | "loss" | "scratch";
}

export interface SimilarTradesResult {
  available: boolean;
  /** Always populated — an unavailable result must say why. */
  reason: string;
  /** Trades in the comparison pool at the cut. */
  poolSize: number;
  minPoolSize: number;
  similarityFloor: number;
  /** Empty unless `available`. */
  matches: SimilarMatch[];
  /**
   * Aggregate outcome of the matches, gated at `MIN_MATCHES_FOR_STATS`.
   * Null means the neighbours are too few to summarise — the list can still be
   * shown, because individual trades are facts while their win rate is an
   * estimate.
   */
  stats: CellStats | null;
  /** Axes that survived the variance and coverage checks. */
  featuresUsed: FeatureKey[];
}

export interface SimilarOptions {
  minPoolSize?: number;
  similarityFloor?: number;
  maxMatches?: number;
  minMatchesForStats?: number;
}

function unavailable(reason: string, poolSize: number, opts: Required<Pick<SimilarOptions, "minPoolSize" | "similarityFloor">>): SimilarTradesResult {
  return {
    available: false, reason, poolSize,
    minPoolSize: opts.minPoolSize, similarityFloor: opts.similarityFloor,
    matches: [], stats: null, featuresUsed: [],
  };
}

/**
 * Find closed trades whose entry conditions resembled `candidate`.
 *
 * The pool is drawn from a point-in-time view, so a workspace opened against a
 * historical moment compares only against what was knowable then — the same
 * guarantee the rest of the knowledge layer runs on.
 */
export function findSimilarTrades(
  candidate: FeatureVector,
  view: PointInTimeView<TradeObservation>,
  opts: SimilarOptions = {},
): SimilarTradesResult {
  const minPoolSize = opts.minPoolSize ?? MIN_POOL_SIZE;
  const similarityFloor = opts.similarityFloor ?? SIMILARITY_FLOOR;
  const maxMatches = opts.maxMatches ?? MAX_MATCHES;
  const minMatchesForStats = opts.minMatchesForStats ?? MIN_MATCHES_FOR_STATS;
  const gate = { minPoolSize, similarityFloor };

  const pool = view.rows.filter((t) => t.features != null);
  if (pool.length < minPoolSize) {
    return unavailable(
      `Needs ${minPoolSize} closed trades with recorded indicator readings to compare against; ${pool.length} so far.`,
      pool.length, gate,
    );
  }

  const stats = normalisationStats(pool.map((t) => t.features!));
  if (stats.usable.length < 2) {
    return unavailable(
      "The recorded setups vary on too few indicators to measure similarity meaningfully.",
      pool.length, gate,
    );
  }

  const candidateVec = standardise(candidate, stats);
  const scored: SimilarMatch[] = [];

  for (const t of pool) {
    const sim = cosine(candidateVec, standardise(t.features!, stats));
    if (sim == null || sim < similarityFloor) continue;
    scored.push({
      tradeId: t.tradeId,
      symbol: t.symbol,
      strategyId: t.strategyId,
      closedAt: t.closedAt,
      similarity: round4(sim),
      pnl: t.pnl,
      rMultiple: realizedR(t.pnl, t.plannedRisk),
      outcome: classifyOutcome(t.pnl, t.plannedRisk, t.exitReason),
    });
  }

  if (scored.length === 0) {
    return unavailable(
      `No closed trade resembles this setup closely enough (similarity floor ${similarityFloor}).`,
      pool.length, gate,
    );
  }

  scored.sort((a, b) => b.similarity - a.similarity);
  const matches = scored.slice(0, maxMatches);
  const matchIds = new Set(matches.map((m) => m.tradeId));
  const matchedTrades = pool.filter((t) => matchIds.has(t.tradeId));

  return {
    available: true,
    reason: `${matches.length} closed trade${matches.length === 1 ? "" : "s"} above the ${similarityFloor} similarity floor, from a pool of ${pool.length}.`,
    poolSize: pool.length,
    minPoolSize,
    similarityFloor,
    matches,
    stats: matches.length >= minMatchesForStats ? summarise(matchedTrades, minMatchesForStats) : null,
    featuresUsed: stats.usable,
  };
}
