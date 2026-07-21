/**
 * TradeCore Pro — Custom strategy rule schema (the no-code builder contract)
 *
 * A custom strategy is a DATA document, never code. This module is the single
 * source of truth for what that document may contain: the indicator
 * vocabulary (every value is something the engine ALREADY computes each scan
 * — see SignalRow in lib/strategy.ts — or derives trivially from the candle
 * windows), the comparison operators, the stop-placement modes, and the
 * bounds. Everything is zod-validated at the API boundary, so the
 * interpreter (lib/strategies/custom.ts) only ever sees well-formed rules.
 *
 * v1 logic model (user decision): each side (long / short) is a simple AND
 * list — every condition must hold for that side to propose a trade. A side
 * with no list is disabled. OR-groups are a future extension.
 */
import { z } from "zod/v4";

// ── Indicator vocabulary ─────────────────────────────────────────────────────
// numeric: compared with gt/gte/lt/lte against a literal number.
// enum/bool: compared with eq.
// derived: computed cheaply in the interpreter from mtf/clock (still no code).
export const NUMERIC_INDICATORS = {
  rsi:            { label: "RSI (14, 5m)",                min: 0,    max: 100 },
  adx:            { label: "ADX (14, 5m)",                min: 0,    max: 100 },
  atrPercent:     { label: "ATR % of price (1m)",         min: 0,    max: 50 },
  macdHistogram:  { label: "MACD histogram (3m)",         min: -1e9, max: 1e9 },
  volumeRatio:    { label: "Volume vs 20-bar avg (1m)",   min: 0,    max: 1000 },
  confidence:     { label: "Bullish vote score (0-100)",  min: 0,    max: 100 },
  shortConfidence:{ label: "Bearish vote score (0-100)",  min: 0,    max: 100 },
  lastPrice:      { label: "Last price",                  min: 0,    max: 1e12 },
  hourUtc:        { label: "Hour of day (UTC, 0-23)",     min: 0,    max: 23 },
  pctFromHigh20:  { label: "% below 20-bar high (15m)",   min: 0,    max: 100 },
  pctFromLow20:   { label: "% above 20-bar low (15m)",    min: 0,    max: 100 },
} as const;

export const ENUM_INDICATORS = {
  regime:          { label: "Market regime", values: ["strong_trend", "weak_trend", "range", "high_volatility", "low_volatility"] as const },
  macroBullish:    { label: "1h macro bullish (price > EMA50)", values: ["true", "false"] as const },
  macroBearish:    { label: "1h macro bearish (price < EMA50)", values: ["true", "false"] as const },
  ema20AboveEma50: { label: "EMA20 above EMA50 (5m)",           values: ["true", "false"] as const },
} as const;

export type NumericIndicatorId = keyof typeof NUMERIC_INDICATORS;
export type EnumIndicatorId = keyof typeof ENUM_INDICATORS;

const numericIds = Object.keys(NUMERIC_INDICATORS) as [NumericIndicatorId, ...NumericIndicatorId[]];
const enumIds = Object.keys(ENUM_INDICATORS) as [EnumIndicatorId, ...EnumIndicatorId[]];

// ── Conditions ───────────────────────────────────────────────────────────────
const NumericCondition = z
  .object({
    indicator: z.enum(numericIds),
    op: z.enum(["gt", "gte", "lt", "lte"]),
    value: z.number().finite(),
  })
  .check((ctx) => {
    const spec = NUMERIC_INDICATORS[ctx.value.indicator];
    if (ctx.value.value < spec.min || ctx.value.value > spec.max) {
      ctx.issues.push({
        code: "custom",
        message: `${spec.label}: value must be between ${spec.min} and ${spec.max}`,
        input: ctx.value.value,
      });
    }
  });

const EnumCondition = z
  .object({
    indicator: z.enum(enumIds),
    op: z.literal("eq"),
    value: z.string(),
  })
  .check((ctx) => {
    const spec = ENUM_INDICATORS[ctx.value.indicator];
    if (!(spec.values as readonly string[]).includes(ctx.value.value)) {
      ctx.issues.push({
        code: "custom",
        message: `${spec.label}: value must be one of ${spec.values.join(", ")}`,
        input: ctx.value.value,
      });
    }
  });

export const ConditionSchema = z.union([NumericCondition, EnumCondition]);
export type CustomCondition = z.infer<typeof ConditionSchema>;

// ── Stop placement ───────────────────────────────────────────────────────────
export const StopSchema = z.discriminatedUnion("mode", [
  // Stop at N × ATR from entry — volatility-scaled, the sane default.
  z.object({ mode: z.literal("atr"), atrMult: z.number().min(0.5).max(10) }),
  // Fixed % distance from entry.
  z.object({ mode: z.literal("percent"), pct: z.number().min(0.05).max(20) }),
  // Structural: the lowest low (long) / highest high (short) of the last N
  // 15m bars — "the level that proves the thesis wrong".
  z.object({ mode: z.literal("swing"), lookback: z.number().int().min(3).max(50) }),
]);
export type CustomStop = z.infer<typeof StopSchema>;

// ── The whole rule document ──────────────────────────────────────────────────
const sideList = z.array(ConditionSchema).min(1).max(8);

export const CustomRulesSchema = z
  .object({
    long: sideList.optional(),
    short: sideList.optional(),
    stop: StopSchema,
    /** Static plan confidence; the per-strategy confidenceThreshold gate
     *  still applies on top, like every built-in strategy. */
    confidence: z.number().min(50).max(95),
  })
  .check((ctx) => {
    if (!ctx.value.long && !ctx.value.short) {
      ctx.issues.push({ code: "custom", message: "At least one side (long or short) must have conditions", input: ctx.value });
    }
  });
export type CustomRules = z.infer<typeof CustomRulesSchema>;

/** Parse unknown JSON into validated rules (throws ZodError on bad input). */
export function parseCustomRules(raw: unknown): CustomRules {
  return CustomRulesSchema.parse(raw);
}

/** Cap on custom strategies per (user, section) — bounds scan-loop work. */
export const MAX_CUSTOM_STRATEGIES = 10;

// ── Human-readable rendering (Strategies page chips, decision reports) ──────
export function describeCondition(c: CustomCondition): string {
  const OPS: Record<string, string> = { gt: ">", gte: "≥", lt: "<", lte: "≤", eq: "=" };
  const label = (NUMERIC_INDICATORS as Record<string, { label: string }>)[c.indicator]?.label
    ?? (ENUM_INDICATORS as Record<string, { label: string }>)[c.indicator]?.label
    ?? c.indicator;
  return `${label} ${OPS[c.op]} ${c.value}`;
}

export function describeRules(rules: CustomRules): string[] {
  const out: string[] = [];
  if (rules.long) out.push(`LONG when ${rules.long.map(describeCondition).join(" AND ")}`);
  if (rules.short) out.push(`SHORT when ${rules.short.map(describeCondition).join(" AND ")}`);
  const stop =
    rules.stop.mode === "atr" ? `Stop: ${rules.stop.atrMult}× ATR` :
    rules.stop.mode === "percent" ? `Stop: ${rules.stop.pct}% from entry` :
    `Stop: ${rules.stop.lookback}-bar swing level (15m)`;
  out.push(stop);
  return out;
}
