/**
 * TradeCore Pro — gated memory influence
 *
 * The only part of this product where the engine's own history is allowed to
 * change what it does. Everything before this phase was read-only by
 * construction; from here the account's record can withhold a trade the
 * strategies wanted to take. That is a genuinely different risk category, so
 * the design is built around five hard limits rather than one flag.
 *
 *  1. TIGHTENING ONLY. Memory can raise the bar a plan must clear. It can
 *     never lower one, and it can never create a plan. The worst case is
 *     therefore a trade not taken — never a trade taken that no strategy
 *     asked for. A symmetric "confidence adjustment" that also loosens is
 *     strictly more dangerous for a strictly smaller benefit: the value in a
 *     trade history is overwhelmingly in identifying where the account
 *     reliably LOSES, and acting on that needs only one direction.
 *
 *  2. NO-OP AT ZERO, PROVABLY. The bar is `reference + delta`, where
 *     `reference` is the bar the plan demonstrably already cleared —
 *     `min(strategyThreshold, plan.confidence)`. At delta 0 the condition is
 *     `confidence >= min(threshold, confidence)`, which is true for every
 *     plan that exists. Influence off, or influence on with no qualifying
 *     cell, is byte-identical to the engine without this module. The harness
 *     asserts it rather than trusting the argument.
 *
 *  3. ONLY EVIDENCE THAT SURVIVED CORRECTION. A cell contributes only if it
 *     cleared P7's sample gate AND its Benjamini–Hochberg q-value is inside
 *     the family's FDR budget. An impressive-looking cell of 12 trades, or
 *     one of 200 that BH says is noise, contributes exactly nothing.
 *
 *  4. BOUNDED, AND THE BOUND IS THE LAST WORD. Per-cell deltas saturate, the
 *     combination is clamped, and the clamp is applied after summing — so no
 *     stack of dimensions can conspire past the configured maximum.
 *
 *  5. VERSIONED. The state carries a content hash of the rules that produced
 *     it. Every applied delta is logged against that version, so "why was
 *     this trade withheld in March?" is answerable in December, and a
 *     refreshed state cannot be mistaken for the one that acted.
 */
import { createHash } from "crypto";
import { round2, round4 } from "../metrics/kernel";
import {
  sessionOf, volatilityBucketOf,
  type CellDimension, type KnowledgeCell, type KnowledgeReport,
} from "../knowledge/cells";

/** Maximum confidence points memory may add to any plan's bar. */
export const DEFAULT_MAX_DELTA = 10;

/**
 * Win-rate shortfall at which a cell's delta saturates.
 *
 * A cell 20 percentage points below the account baseline is as bad as this
 * system will treat anything — beyond that the delta stops growing, because
 * the difference between "very bad" and "catastrophically bad" should be
 * handled by the user disabling a strategy, not by an automatic knob.
 */
export const SATURATION_GAP = 0.2;

/**
 * Deltas below this are treated as zero.
 *
 * Confidence is a 0–100 score read to the nearest point; a 0.3-point
 * adjustment cannot matter and would only produce log noise and unexplainable
 * near-miss rejections.
 */
export const MIN_APPLIED_DELTA = 1;

/** Dimensions memory is allowed to act on. */
export const INFLUENCED_DIMENSIONS: readonly CellDimension[] = [
  "strategy_regime", "symbol_strategy", "session", "volatility",
];

export interface InfluenceRule {
  dimension: CellDimension;
  key: string;
  label: string;
  samples: number;
  winRate: number;
  /** 95% Wilson interval retained so council replay never receives a bare estimate. */
  winRateLow: number;
  winRateHigh: number;
  baselineWinRate: number;
  qValue: number;
  /** Confidence points this cell adds to the bar. Always > 0. */
  delta: number;
}

export interface InfluenceState {
  /** "memory-0" when inert; "memory-1:<hash>" when it carries rules. */
  version: string;
  /** Whether the engine is permitted to act on this state at all. */
  enabled: boolean;
  /** The point-in-time cut the underlying cells were built at. */
  asOf: number;
  builtAt: number;
  maxDelta: number;
  rules: InfluenceRule[];
}

/** The inert state. Structurally incapable of changing a decision. */
export const INERT_STATE: InfluenceState = {
  version: "memory-0",
  enabled: false,
  asOf: 0,
  builtAt: 0,
  maxDelta: DEFAULT_MAX_DELTA,
  rules: [],
};

/**
 * The per-cell delta.
 *
 * Linear in the shortfall below baseline, saturating at `SATURATION_GAP`.
 * Cells at or above baseline produce 0 — this is the tightening-only rule
 * expressed in arithmetic rather than enforced by a later clamp, so there is
 * no path where a sign error turns into a loosened gate.
 */
export function deltaForCell(winRate: number, baselineWinRate: number, maxDelta: number): number {
  const shortfall = baselineWinRate - winRate;
  if (!(shortfall > 0)) return 0;
  return round2(Math.min(1, shortfall / SATURATION_GAP) * maxDelta);
}

export interface BuildStateOptions {
  maxDelta?: number;
  enabled?: boolean;
  now?: number;
}

/**
 * Distil a knowledge report into the rules memory may act on.
 *
 * Everything that does not survive both gates is dropped here, at build time,
 * rather than checked at decision time — so the state a scan reads contains
 * only actionable evidence and the hot path has nothing to get wrong.
 */
export function buildInfluenceState(report: KnowledgeReport, opts: BuildStateOptions = {}): InfluenceState {
  const maxDelta = opts.maxDelta ?? DEFAULT_MAX_DELTA;
  const enabled = opts.enabled ?? false;
  const builtAt = opts.now ?? Date.now();
  const baseline = report.baselineWinRate;

  const rules: InfluenceRule[] = [];
  if (baseline != null) {
    for (const cell of report.cells) {
      if (cell.gated || cell.winRate == null || cell.winRateLow == null || cell.winRateHigh == null) continue;
      if (!INFLUENCED_DIMENSIONS.includes(cell.dimension)) continue;
      // The correction is the whole point: without it, four dimensions across
      // a dozen symbols guarantee a handful of "significant" cells on noise.
      if (cell.significance?.significant !== true) continue;

      const delta = deltaForCell(cell.winRate, baseline, maxDelta);
      if (delta < MIN_APPLIED_DELTA) continue;

      rules.push({
        dimension: cell.dimension,
        key: cell.key,
        label: cell.label,
        samples: cell.samples,
        winRate: cell.winRate,
        winRateLow: cell.winRateLow,
        winRateHigh: cell.winRateHigh,
        baselineWinRate: baseline,
        qValue: cell.significance.qValue,
        delta,
      });
    }
  }

  rules.sort((a, b) => b.delta - a.delta || a.key.localeCompare(b.key));

  return {
    version: rules.length === 0 ? INERT_STATE.version : `memory-1:${hashRules(rules, maxDelta)}`,
    enabled,
    asOf: report.asOf,
    builtAt,
    maxDelta,
    rules,
  };
}

/**
 * Content hash of the acting rules.
 *
 * Covers the delta bound as well as the rules, because the same cells under a
 * different cap are a different memory. Excludes `builtAt` — rebuilding an
 * unchanged state must not mint a new version, or the log would imply changes
 * that never happened.
 */
export function hashRules(rules: readonly InfluenceRule[], maxDelta: number): string {
  const canonical = JSON.stringify({
    maxDelta,
    rules: [...rules]
      .sort((a, b) => `${a.dimension}|${a.key}`.localeCompare(`${b.dimension}|${b.key}`))
      .map((r) => [r.dimension, r.key, r.delta]),
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 12);
}

/** The facts about a candidate that decide which cells it falls in. */
export interface InfluenceCandidate {
  strategyId: string;
  symbol: string;
  regime: string | null;
  /** Entry time, for the session cell. */
  entryTime: number;
  atrPercent: number | null;
  /** The plan's own confidence, 0–100. */
  confidence: number;
  /** The confidence bar this plan's strategy is configured with. */
  strategyThreshold: number;
}

export interface AppliedRule {
  dimension: CellDimension;
  key: string;
  label: string;
  delta: number;
  samples: number;
  winRate: number;
  qValue: number;
}

export interface InfluenceOutcome {
  /** False whenever the engine's behaviour is unchanged. */
  applied: boolean;
  admitted: boolean;
  /** Total confidence points added to the bar, after clamping. 0 when inert. */
  delta: number;
  /** The bar this plan had already cleared. */
  reference: number;
  /** reference + delta — what it must now clear. */
  requiredConfidence: number;
  confidence: number;
  version: string;
  rules: AppliedRule[];
  reason: string;
}

/** Which of a candidate's cells each dimension names. */
function keysFor(candidate: InfluenceCandidate): Partial<Record<CellDimension, string>> {
  const out: Partial<Record<CellDimension, string>> = {
    symbol_strategy: `${candidate.symbol}|${candidate.strategyId}`,
    session: sessionOf(candidate.entryTime),
  };
  if (candidate.regime) out.strategy_regime = `${candidate.strategyId}|${candidate.regime}`;
  const vol = volatilityBucketOf(candidate.atrPercent);
  if (vol) out.volatility = vol;
  return out;
}

/**
 * Decide whether memory withholds this plan.
 *
 * The reference bar is `min(strategyThreshold, confidence)` — the bar the plan
 * has actually cleared. Using the configured threshold alone would break the
 * no-op guarantee, because confidence unification can leave a legitimate plan
 * fractionally below its own strategy's number without re-gating (see
 * strategies/selector.ts). Taking the minimum makes delta 0 unconditionally
 * admit, and keeps the response to a small delta small.
 */
export function evaluateInfluence(
  state: InfluenceState,
  candidate: InfluenceCandidate,
): InfluenceOutcome {
  const reference = Math.min(candidate.strategyThreshold, candidate.confidence);
  const inert: InfluenceOutcome = {
    applied: false,
    admitted: true,
    delta: 0,
    reference,
    requiredConfidence: reference,
    confidence: candidate.confidence,
    version: state.version,
    rules: [],
    reason: "no memory influence",
  };

  if (!state.enabled || state.rules.length === 0) return inert;

  const keys = keysFor(candidate);
  const matched: AppliedRule[] = [];
  let raw = 0;

  for (const rule of state.rules) {
    if (keys[rule.dimension] !== rule.key) continue;
    raw += rule.delta;
    matched.push({
      dimension: rule.dimension, key: rule.key, label: rule.label,
      delta: rule.delta, samples: rule.samples, winRate: rule.winRate, qValue: rule.qValue,
    });
  }

  // The clamp lands AFTER the sum, so four dimensions cannot stack past the
  // configured bound. It is the last word on how far memory can reach.
  const delta = round2(Math.min(raw, state.maxDelta));
  if (delta < MIN_APPLIED_DELTA) return inert;

  const requiredConfidence = round2(reference + delta);
  const admitted = candidate.confidence >= requiredConfidence;

  return {
    applied: true,
    admitted,
    delta,
    reference: round2(reference),
    requiredConfidence,
    confidence: candidate.confidence,
    version: state.version,
    rules: matched,
    reason: admitted
      ? `cleared a bar raised ${delta} points by ${describe(matched)}`
      : `confidence ${round2(candidate.confidence)} below the ${requiredConfidence} bar — raised ${delta} points by ${describe(matched)}`,
  };
}

function describe(rules: readonly AppliedRule[]): string {
  if (rules.length === 0) return "memory";
  const named = rules
    .slice(0, 2)
    .map((r) => `${r.label} (${(r.winRate * 100).toFixed(0)}% over ${r.samples})`)
    .join(", ");
  return rules.length > 2 ? `${named} and ${rules.length - 2} more` : named;
}

/**
 * A plain-language summary of what a state would do, for the settings screen.
 * Written so a user can decide whether to enable it without reading a table.
 */
export function summariseState(state: InfluenceState): string {
  if (state.rules.length === 0) {
    return "No cell in your record has both enough trades and evidence that survives multiple-comparison correction. Memory would change nothing.";
  }
  const worst = state.rules[0]!;
  return (
    `${state.rules.length} cell${state.rules.length === 1 ? "" : "s"} qualify. ` +
    `The strongest is ${worst.label} at ${(worst.winRate * 100).toFixed(0)}% over ${worst.samples} trades ` +
    `against a ${(worst.baselineWinRate * 100).toFixed(0)}% baseline, raising its bar by ${worst.delta} points. ` +
    `Memory can only withhold trades — it never takes one your strategies did not ask for.`
  );
}

/** Rounded for the API, where a raw float reads as more precision than exists. */
export const displayWinRate = (n: number): number => round4(n);
