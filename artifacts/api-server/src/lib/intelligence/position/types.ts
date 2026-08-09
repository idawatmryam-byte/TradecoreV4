import { z } from "zod";
import { deepFreeze, type ReadonlyDeep } from "../canonical";

const finite = z.number().finite();
const hash = z.string().regex(/^[a-f0-9]{64}$/i);
const isoTime = z.string().datetime();

export const POSITION_THESIS_VERSION = "position-thesis-v1" as const;
export const POSITION_POLICY_VERSION = "phase7-bounded-management-v1" as const;

export const PositionManagementModeSchema = z.enum([
  "fixed",
  "phase7_shadow",
  "phase7_active",
]);
export const PositionManagementAuthoritySchema = z.enum(["fixed", "phase7"]);
export const PositionThesisStateSchema = z.enum([
  "VALID",
  "WEAKENING",
  "INVALIDATED",
  "TARGET_DEGRADED",
  "DATA_UNCERTAIN",
]);
export const PositionManagementActionTypeSchema = z.enum([
  "HOLD",
  "REDUCE",
  "TIGHTEN_STOP",
  "APPLY_TRAILING",
  "EXIT",
  "FREEZE",
]);

export const PositionThesisSchema = z
  .object({
    schemaVersion: z.literal(POSITION_THESIS_VERSION),
    thesisId: z.string().uuid(),
    symbol: z.string().min(1).max(80),
    side: z.enum(["long", "short"]),
    context: z.string().min(1).max(3000),
    trigger: z.string().min(1).max(1000),
    invalidationConditions: z.array(z.string().min(1).max(500)).min(1).max(20),
    targetRationale: z.string().min(1).max(1000),
    expectedPath: z.array(z.string().min(1).max(500)).min(1).max(20),
    expectedDurationSeconds: finite.int().positive(),
    maximumDurationSeconds: finite.int().positive(),
    managementPolicyVersion: z.literal(POSITION_POLICY_VERSION),
    permittedActions: z.array(PositionManagementActionTypeSchema).min(1),
    entry: z
      .object({
        price: finite.positive(),
        initialStopPrice: finite.positive(),
        targetPrice: finite.positive(),
        regime: z.enum([
          "strong_trend",
          "weak_trend",
          "range",
          "high_volatility",
          "low_volatility",
        ]),
        dominantDirection: z.enum(["bullish", "bearish", "neutral"]),
        marketStateFingerprint: hash,
        marketStateVersion: z.string().min(1).max(120),
        dataTimestamp: isoTime,
      })
      .strict(),
    createdAt: isoTime,
    fingerprint: hash,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.maximumDurationSeconds < value.expectedDurationSeconds) {
      ctx.addIssue({
        code: "custom",
        path: ["maximumDurationSeconds"],
        message: "maximum duration must not be shorter than expected duration",
      });
    }
    const validGeometry =
      value.side === "long"
        ? value.entry.initialStopPrice < value.entry.price &&
          value.entry.targetPrice > value.entry.price
        : value.entry.initialStopPrice > value.entry.price &&
          value.entry.targetPrice < value.entry.price;
    if (!validGeometry)
      ctx.addIssue({
        code: "custom",
        path: ["entry"],
        message: "entry, stop, and target geometry is invalid",
      });
  });

export const PositionThesisEvaluationSchema = z
  .object({
    schemaVersion: z.literal("position-thesis-evaluation-v1"),
    thesisId: z.string().uuid(),
    tradeId: finite.int().positive(),
    state: PositionThesisStateSchema,
    marketStateFingerprint: hash.nullable(),
    evaluatedAt: isoTime,
    progressR: finite,
    elapsedFraction: finite.nonnegative(),
    supportingEvidence: z.array(z.string().min(1).max(500)).max(20),
    contraryEvidence: z.array(z.string().min(1).max(500)).max(20),
    reasonCodes: z.array(z.string().min(1).max(120)).min(1).max(20),
    fingerprint: hash,
  })
  .strict();

export const PositionManagementActionSchema = z
  .object({
    schemaVersion: z.literal("position-management-action-v1"),
    actionId: z.string().uuid(),
    thesisId: z.string().uuid(),
    tradeId: finite.int().positive(),
    type: PositionManagementActionTypeSchema,
    state: PositionThesisStateSchema,
    policyVersion: z.literal(POSITION_POLICY_VERSION),
    proposedStopPrice: finite.positive().nullable(),
    reductionFraction: finite.min(0).max(1).nullable(),
    trailingMode: z.enum(["atr"]).nullable(),
    reasonCodes: z.array(z.string().min(1).max(120)).min(1).max(20),
    marketStateFingerprint: hash.nullable(),
    proposedAt: isoTime,
    fingerprint: hash,
  })
  .strict();

export const PositionActionValidationSchema = z
  .object({
    schemaVersion: z.literal("position-action-validation-v1"),
    actionFingerprint: hash,
    valid: z.boolean(),
    currentMaximumLoss: finite.nonnegative(),
    proposedMaximumLoss: finite.nonnegative(),
    reasonCodes: z.array(z.string().min(1).max(120)).min(1).max(20),
    validatedAt: isoTime,
    fingerprint: hash,
  })
  .strict();

export type PositionManagementMode = z.infer<
  typeof PositionManagementModeSchema
>;
export type PositionManagementAuthority = z.infer<
  typeof PositionManagementAuthoritySchema
>;
export type PositionThesisState = z.infer<typeof PositionThesisStateSchema>;
export type PositionManagementActionType = z.infer<
  typeof PositionManagementActionTypeSchema
>;
export type PositionThesis = ReadonlyDeep<z.infer<typeof PositionThesisSchema>>;
export type PositionThesisEvaluation = ReadonlyDeep<
  z.infer<typeof PositionThesisEvaluationSchema>
>;
export type PositionManagementAction = ReadonlyDeep<
  z.infer<typeof PositionManagementActionSchema>
>;
export type PositionActionValidation = ReadonlyDeep<
  z.infer<typeof PositionActionValidationSchema>
>;

export function parsePositionThesis(input: unknown): PositionThesis {
  return deepFreeze(PositionThesisSchema.parse(input));
}

export function parsePositionThesisEvaluation(
  input: unknown,
): PositionThesisEvaluation {
  return deepFreeze(PositionThesisEvaluationSchema.parse(input));
}

export function parsePositionManagementAction(
  input: unknown,
): PositionManagementAction {
  return deepFreeze(PositionManagementActionSchema.parse(input));
}

export function parsePositionActionValidation(
  input: unknown,
): PositionActionValidation {
  return deepFreeze(PositionActionValidationSchema.parse(input));
}
