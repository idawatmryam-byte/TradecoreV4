import { z } from "zod";
import { deepFreeze, type ReadonlyDeep } from "../canonical";

const finite = z.number().finite();
const hash = z.string().regex(/^[a-f0-9]{64}$/i);
const isoTime = z.string().datetime();

export const RESEARCH_EXPERIMENT_VERSION = "phase8-experiment-v1" as const;
export const RESEARCH_REPLAY_VERSION = "phase8-full-brain-replay-v1" as const;
export const RESEARCH_PARTITION_VERSION = "purged-walk-forward-v1" as const;
export const RESEARCH_REPORT_VERSION = "phase8-promotion-report-v1" as const;

export const ResearchWindowSchema = z
  .object({
    startInclusive: isoTime,
    endExclusive: isoTime,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Date.parse(value.startInclusive) >= Date.parse(value.endExclusive)) {
      ctx.addIssue({
        code: "custom",
        path: ["endExclusive"],
        message: "window end must be after its start",
      });
    }
  });

export const ResearchFoldSchema = z
  .object({
    foldId: z.string().min(1).max(80),
    train: ResearchWindowSchema,
    validation: ResearchWindowSchema,
    purgeMs: finite.int().nonnegative(),
    embargoMs: finite.int().nonnegative(),
  })
  .strict();

export const ResearchPartitionPlanSchema = z
  .object({
    version: z.literal(RESEARCH_PARTITION_VERSION),
    method: z.literal("expanding-window"),
    folds: z.array(ResearchFoldSchema).min(1).max(20),
    untouchedHoldout: ResearchWindowSchema,
    fingerprint: hash,
  })
  .strict();

export const ResearchStressScenarioSchema = z
  .object({
    scenarioId: z.string().min(1).max(80),
    label: z.string().min(1).max(160),
    feeMultiplier: finite.min(1).max(20),
    slippageMultiplier: finite.min(1).max(20),
    spreadMultiplier: finite.min(1).max(20),
    latencyMs: finite.int().nonnegative().max(300_000),
    missingDataFraction: finite.min(0).max(0.5),
    adverseIntrabarOrdering: z.boolean(),
  })
  .strict();

export const ResearchExperimentManifestSchema = z
  .object({
    schemaVersion: z.literal(RESEARCH_EXPERIMENT_VERSION),
    experimentId: z.string().uuid(),
    name: z.string().trim().min(1).max(160),
    mode: z.literal("research"),
    cannotExecute: z.literal(true),
    control: z
      .object({
        brainVersion: z.literal("brain-v0"),
        manifestFingerprint: hash,
      })
      .strict(),
    candidate: z
      .object({
        brainVersion: z.string().trim().min(1).max(120),
        configFingerprint: hash,
        modelFingerprint: hash,
        narrativeMode: z.enum(["deterministic-only", "ai-observational"]),
      })
      .strict(),
    data: z
      .object({
        provider: z.enum(["binance", "oanda", "fixture"]),
        marketType: z.enum(["spot", "futures", "forex"]),
        symbols: z.array(z.string().trim().min(1).max(80)).min(1).max(100),
        timeframe: z.string().trim().min(1).max(20),
        window: ResearchWindowSchema,
        asOf: isoTime,
        dataFingerprint: hash,
        syntheticDataAllowed: z.boolean(),
      })
      .strict(),
    partitions: ResearchPartitionPlanSchema,
    costs: z
      .object({
        feeRatePerLeg: finite.nonnegative().max(0.2),
        slippageRatePerLeg: finite.nonnegative().max(0.2),
        spreadRate: finite.nonnegative().max(0.2),
        latencyMs: finite.int().nonnegative().max(300_000),
        fillModelVersion: z.string().trim().min(1).max(120),
      })
      .strict(),
    versions: z
      .object({
        sourceCodeHash: hash,
        strategyCatalogVersion: z.string().trim().min(1).max(120),
        marketStateVersion: z.string().trim().min(1).max(120),
        specialistVersion: z.string().trim().min(1).max(120),
        evidenceVersion: z.string().trim().min(1).max(120),
        portfolioVersion: z.string().trim().min(1).max(120),
        positionPolicyVersion: z.string().trim().min(1).max(120),
      })
      .strict(),
    stressScenarios: z.array(ResearchStressScenarioSchema).min(1).max(20),
    deterministicSeed: finite.int().nonnegative().max(2_147_483_647),
    multipleTesting: z
      .object({
        procedure: z.literal("benjamini-hochberg"),
        falseDiscoveryRate: finite.gt(0).lt(1),
        hypothesesDeclaredBeforeRun: finite.int().positive().max(10_000),
      })
      .strict(),
    createdAt: isoTime,
    fingerprint: hash,
  })
  .strict()
  .superRefine((value, ctx) => {
    const symbols = value.data.symbols.map((symbol) => symbol.toUpperCase());
    if (new Set(symbols).size !== symbols.length) {
      ctx.addIssue({
        code: "custom",
        path: ["data", "symbols"],
        message: "symbols must be unique",
      });
    }
    if (
      Date.parse(value.data.asOf) < Date.parse(value.data.window.endExclusive)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["data", "asOf"],
        message: "asOf cannot precede the experiment data cutoff",
      });
    }
    if (value.data.provider === "fixture" && !value.data.syntheticDataAllowed) {
      ctx.addIssue({
        code: "custom",
        path: ["data", "syntheticDataAllowed"],
        message: "fixture data must be explicitly authorized",
      });
    }
  });

export const ResearchDecisionEventSchema = z
  .object({
    schemaVersion: z.literal(RESEARCH_REPLAY_VERSION),
    experimentId: z.string().uuid(),
    sequence: finite.int().nonnegative(),
    partitionId: z.string().min(1).max(80),
    observedAt: isoTime,
    dataTimestamp: isoTime,
    symbol: z.string().min(1).max(80),
    marketStateFingerprint: hash,
    specialist: z
      .object({
        stance: z.enum(["long", "short", "mixed", "abstain"]),
        opinionIds: z.array(z.string().uuid()).max(100),
        actionableOpinions: finite.int().nonnegative(),
        abstentions: finite.int().nonnegative(),
      })
      .strict(),
    evidence: z
      .object({
        status: z.enum(["unavailable", "observational", "approved"]),
        ruleVersion: z.string().nullable(),
        evidenceIds: z.array(z.string().uuid()).max(100),
      })
      .strict(),
    control: z
      .object({
        action: z.enum(["ENTER_NOW", "OBSERVE"]),
        candidateCount: finite.int().nonnegative(),
        strategyId: z.string().nullable(),
      })
      .strict(),
    council: z
      .object({
        decisionId: z.string().uuid(),
        decisionFingerprint: hash,
        strategyId: z.string().nullable(),
        action: z.enum([
          "ENTER_NOW",
          "WAIT_FOR_TRIGGER",
          "OBSERVE",
          "REJECT",
          "REDUCE",
          "EXIT",
        ]),
        reasonCode: z.string().min(1).max(160),
        decisionStrength: finite.min(0).max(1),
        uncertainty: finite.min(0).max(1),
      })
      .strict(),
    portfolio: z
      .object({
        projectionFingerprint: hash,
        disposition: z.enum([
          "SHADOW_ALLOCATED",
          "WAIT_FOR_TRIGGER",
          "OBSERVE",
          "REJECTED",
        ]),
        rank: finite.int().positive(),
        allocationFraction: finite.min(0).max(1),
        reasonCodes: z.array(z.string().min(1).max(160)).max(30),
      })
      .strict(),
    outcome: z.enum([
      "TRADE_CANDIDATE",
      "WAITING",
      "OBSERVED",
      "REJECTED",
      "EXPIRED",
    ]),
    cannotExecute: z.literal(true),
    fingerprint: hash,
  })
  .strict();

export const ResearchManagementEventSchema = z
  .object({
    schemaVersion: z.literal(RESEARCH_REPLAY_VERSION),
    experimentId: z.string().uuid(),
    sequence: finite.int().nonnegative(),
    partitionId: z.string().min(1).max(80),
    observedAt: isoTime,
    tradeId: finite.int().positive(),
    symbol: z.string().min(1).max(80),
    thesisFingerprint: hash,
    state: z.enum([
      "VALID",
      "WEAKENING",
      "INVALIDATED",
      "TARGET_DEGRADED",
      "DATA_UNCERTAIN",
    ]),
    proposedAction: z.enum([
      "HOLD",
      "REDUCE",
      "TIGHTEN_STOP",
      "APPLY_TRAILING",
      "EXIT",
      "FREEZE",
    ]),
    actionFingerprint: hash,
    proposedStopPrice: finite.positive().nullable(),
    reductionFraction: finite.min(0).max(1).nullable(),
    validationFingerprint: hash,
    valid: z.boolean(),
    currentMaximumLoss: finite.nonnegative(),
    proposedMaximumLoss: finite.nonnegative(),
    cannotExecute: z.literal(true),
    fingerprint: hash,
  })
  .strict();

export const ResearchMetricsSchema = z
  .object({
    eligibleDecisions: finite.int().nonnegative(),
    closedTrades: finite.int().nonnegative(),
    calendarDays: finite.nonnegative(),
    grossPnl: finite,
    costs: finite.nonnegative(),
    netPnl: finite,
    netExpectancyR: finite.nullable(),
    profitFactor: finite.nullable(),
    maxDrawdown: finite.min(0).max(1),
    expectedShortfallR: finite.nullable(),
    abstentionRate: finite.min(0).max(1),
    regimeMix: z.record(z.string(), finite.int().nonnegative()),
    uncertainty: z
      .object({
        method: z.literal("bootstrap-percentile"),
        confidenceLevel: finite.gt(0).lt(1),
        lowerNetExpectancyR: finite.nullable(),
        upperNetExpectancyR: finite.nullable(),
        samples: finite.int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export const ResearchAttributionSchema = z
  .object({
    perception: finite,
    selection: finite,
    evidence: finite,
    allocation: finite,
    executionCosts: finite,
    management: finite,
    residual: finite,
    unit: z.enum(["net-pnl", "decision-count", "R"]),
  })
  .strict();

export const ResearchPromotionReportSchema = z
  .object({
    schemaVersion: z.literal(RESEARCH_REPORT_VERSION),
    experimentId: z.string().uuid(),
    manifestFingerprint: hash,
    generatedAt: isoTime,
    control: ResearchMetricsSchema,
    candidate: ResearchMetricsSchema,
    attribution: ResearchAttributionSchema,
    goldenStream: z
      .object({
        expectedFingerprint: hash,
        actualFingerprint: hash,
        reproducible: z.boolean(),
      })
      .strict(),
    leakageChecks: z
      .array(
        z
          .object({
            check: z.string().min(1).max(160),
            passed: z.boolean(),
            detail: z.string().min(1).max(1000),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    multipleTesting: z
      .object({
        procedure: z.literal("benjamini-hochberg"),
        falseDiscoveryRate: finite.gt(0).lt(1),
        hypotheses: finite.int().positive(),
        discoveries: finite.int().nonnegative(),
      })
      .strict(),
    gateChecks: z
      .array(
        z
          .object({
            key: z.string().min(1).max(120),
            passed: z.boolean(),
            actual: z.string().min(1).max(500),
            required: z.string().min(1).max(500),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    recommendation: z.enum([
      "REJECT",
      "REMAIN_RESEARCH",
      "ELIGIBLE_FOR_HUMAN_REVIEW",
    ]),
    humanApprovalRequired: z.literal(true),
    limitations: z.array(z.string().min(1).max(1000)).max(100),
    fingerprint: hash,
  })
  .strict();

export type ResearchWindow = z.infer<typeof ResearchWindowSchema>;
export type ResearchFold = z.infer<typeof ResearchFoldSchema>;
export type ResearchPartitionPlan = ReadonlyDeep<
  z.infer<typeof ResearchPartitionPlanSchema>
>;
export type ResearchStressScenario = z.infer<
  typeof ResearchStressScenarioSchema
>;
export type ResearchExperimentManifest = ReadonlyDeep<
  z.infer<typeof ResearchExperimentManifestSchema>
>;
export type ResearchDecisionEvent = ReadonlyDeep<
  z.infer<typeof ResearchDecisionEventSchema>
>;
export type ResearchManagementEvent = ReadonlyDeep<
  z.infer<typeof ResearchManagementEventSchema>
>;
export type ResearchMetrics = ReadonlyDeep<
  z.infer<typeof ResearchMetricsSchema>
>;
export type ResearchAttribution = ReadonlyDeep<
  z.infer<typeof ResearchAttributionSchema>
>;
export type ResearchPromotionReport = ReadonlyDeep<
  z.infer<typeof ResearchPromotionReportSchema>
>;

export function parseResearchPartitionPlan(
  input: unknown,
): ResearchPartitionPlan {
  return deepFreeze(ResearchPartitionPlanSchema.parse(input));
}

export function parseResearchExperimentManifest(
  input: unknown,
): ResearchExperimentManifest {
  return deepFreeze(ResearchExperimentManifestSchema.parse(input));
}

export function parseResearchDecisionEvent(
  input: unknown,
): ResearchDecisionEvent {
  return deepFreeze(ResearchDecisionEventSchema.parse(input));
}

export function parseResearchManagementEvent(
  input: unknown,
): ResearchManagementEvent {
  return deepFreeze(ResearchManagementEventSchema.parse(input));
}

export function parseResearchPromotionReport(
  input: unknown,
): ResearchPromotionReport {
  return deepFreeze(ResearchPromotionReportSchema.parse(input));
}
