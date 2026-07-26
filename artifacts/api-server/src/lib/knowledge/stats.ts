/**
 * TradeCore Pro — significance testing for knowledge cells
 *
 * The problem this file exists to solve: slice a trade history finely enough
 * and some slice will always look brilliant. Four dimensions across a dozen
 * symbols, five regimes and four sessions is well over a hundred comparisons;
 * at the conventional 5% threshold, five of them come back "significant" on
 * pure noise. Reporting those as discovered edges would be the most
 * expensive kind of wrong — confident, quantified, and fabricated.
 *
 * Two defences:
 *
 *  1. An EXACT binomial test, not the normal approximation. Cells sit right at
 *     the sample gate (n = 30) where the approximation is at its shakiest, and
 *     the whole point of a gate is to be trustworthy at its boundary.
 *
 *  2. Benjamini–Hochberg across every cell tested in the same family, which
 *     controls the false-discovery rate — the share of claimed edges that are
 *     noise. Bonferroni would control the stricter family-wise error rate and
 *     leave nothing standing on a few hundred trades; BH is the honest
 *     trade-off for exploratory work, provided the q-value is reported rather
 *     than quietly converted back into a yes/no.
 */

/** Log-gamma (Lanczos, g=7, n=9). Accurate to ~15 significant figures for x > 0. */
function logGamma(x: number): number {
  const g = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    // Reflection, so the series stays in its convergent range.
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  const z = x - 1;
  let a = g[0]!;
  const t = z + 7.5;
  for (let i = 1; i < 9; i++) a += g[i]! / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/** log C(n, k) — via log-gamma so n in the thousands doesn't overflow. */
function logChoose(n: number, k: number): number {
  return logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);
}

/** Binomial PMF: P(X = k) for X ~ Bin(n, p). */
export function binomialPmf(k: number, n: number, p: number): number {
  if (k < 0 || k > n) return 0;
  if (p <= 0) return k === 0 ? 1 : 0;
  if (p >= 1) return k === n ? 1 : 0;
  return Math.exp(logChoose(n, k) + k * Math.log(p) + (n - k) * Math.log1p(-p));
}

/**
 * Two-sided exact binomial test of `successes` out of `n` against `p0`.
 *
 * Uses the method of small p-values: sum the probability of every outcome no
 * more likely than the one observed. This is the standard two-sided
 * formulation and, unlike doubling the smaller tail, stays correct when the
 * null is asymmetric (p0 = 0.55 with n = 30, say — exactly our case).
 *
 * Returns 1 for n = 0: no data is not evidence of anything.
 */
export function binomialTest(successes: number, n: number, p0: number): number {
  if (n <= 0) return 1;
  if (!(p0 > 0 && p0 < 1)) return 1;

  const observed = binomialPmf(successes, n, p0);
  // Floating-point slack, or outcomes with probability equal to the observed
  // one get excluded by an exact `<=` and the p-value comes back too small.
  const threshold = observed * (1 + 1e-9);

  let total = 0;
  for (let k = 0; k <= n; k++) {
    const pk = binomialPmf(k, n, p0);
    if (pk <= threshold) total += pk;
  }
  return Math.min(1, total);
}

export interface Tested<T> {
  item: T;
  pValue: number;
}

export interface Adjusted<T> {
  item: T;
  pValue: number;
  /** BH-adjusted p-value: the FDR incurred by calling this discovery real. */
  qValue: number;
  /** qValue <= the family's FDR budget. */
  significant: boolean;
}

/** The share of claimed discoveries we accept being noise. */
export const DEFAULT_FDR = 0.1;

/**
 * Benjamini–Hochberg step-up across one family of tests.
 *
 * Adjusted p-values are enforced monotone from the largest downward — the
 * standard correction, and the reason a cell can never be reported as less
 * significant than a cell with a larger raw p-value.
 *
 * The family must be EVERY cell tested, including the unremarkable ones.
 * Running BH over only the cells that already looked good is the same
 * multiple-comparisons error one level up.
 */
export function benjaminiHochberg<T>(tests: readonly Tested<T>[], fdr = DEFAULT_FDR): Adjusted<T>[] {
  const m = tests.length;
  if (m === 0) return [];

  const ordered = tests
    .map((t, i) => ({ ...t, i }))
    .sort((a, b) => a.pValue - b.pValue);

  // Step up from the largest p-value, carrying the running minimum.
  const q = new Array<number>(m);
  let running = 1;
  for (let rank = m; rank >= 1; rank--) {
    const raw = (ordered[rank - 1]!.pValue * m) / rank;
    running = Math.min(running, raw);
    q[rank - 1] = Math.min(1, running);
  }

  const out = new Array<Adjusted<T>>(m);
  ordered.forEach((t, rank) => {
    out[t.i] = {
      item: t.item,
      pValue: t.pValue,
      qValue: q[rank]!,
      significant: q[rank]! <= fdr,
    };
  });
  return out;
}

/**
 * Wilson score interval for a proportion.
 *
 * Reported alongside every gated win rate, because a point estimate from 30
 * trades reads far more precisely than it deserves to. Wilson rather than the
 * normal (Wald) interval: Wald degenerates to zero width at 0% and 100% — it
 * would claim perfect certainty from the very samples that warrant least.
 *
 * `z` defaults to 1.96 (95%).
 */
export function wilsonInterval(successes: number, n: number, z = 1.96): { low: number; high: number } | null {
  if (n <= 0) return null;
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const spread = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, centre - spread), high: Math.min(1, centre + spread) };
}
