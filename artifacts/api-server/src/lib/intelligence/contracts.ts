import { z } from "zod";
import { deepFreeze, sha256Fingerprint, type ReadonlyDeep } from "./canonical";

export const INTELLIGENCE_SCHEMA_VERSION = "1.0.0" as const;
const version = z.literal(INTELLIGENCE_SCHEMA_VERSION);
const isoTime = z.string().datetime();
const hash = z.string().regex(/^[a-f0-9]{64}$/i, "expected SHA-256");
const finite = z.number().finite();

export const EvidenceReferenceSchema = z.object({
  evidenceId: z.string().min(1).max(160),
  kind: z.enum(["observation", "specialist", "statistical", "memory", "portfolio", "execution"]),
  source: z.string().min(1).max(120),
  summary: z.string().min(1).max(1000),
  reference: z.string().min(1).max(500),
  fingerprint: hash.optional(),
  dataTimestamp: isoTime,
  strength: finite.min(0).max(1),
}).strict();

export const OpportunitySchema = z.object({
  schemaVersion: version,
  opportunityId: z.string().uuid(),
  marketStateFingerprint: hash,
  symbol: z.string().min(1).max(80),
  venue: z.enum(["spot", "futures", "forex"]),
  side: z.enum(["long", "short"]),
  observedAt: isoTime,
  expiresAt: isoTime,
  trigger: z.string().min(1).max(1000),
  invalidationConditions: z.array(z.string().min(1).max(500)).min(1).max(20),
  estimatedNetRewardRisk: finite.nullable(),
  uncertainty: finite.min(0).max(1),
}).strict().superRefine((value, ctx) => {
  if (Date.parse(value.expiresAt) <= Date.parse(value.observedAt)) {
    ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "must be after observedAt" });
  }
});

export const StrategyOpinionSchema = z.object({
  schemaVersion: version,
  opinionId: z.string().uuid(),
  specialistId: z.string().min(1).max(120),
  specialistVersion: z.string().min(1).max(120),
  marketStateFingerprint: hash,
  symbol: z.string().min(1).max(80),
  stance: z.enum(["long", "short", "neutral", "abstain"]),
  strength: finite.min(0).max(1),
  applicableRegimes: z.array(z.string().min(1)).min(1).max(20),
  supportingEvidence: z.array(EvidenceReferenceSchema).max(50),
  opposingEvidence: z.array(EvidenceReferenceSchema).max(50),
  trigger: z.string().min(1).max(1000).nullable(),
  invalidationConditions: z.array(z.string().min(1).max(500)).max(20),
  expectedDurationSeconds: finite.int().positive().nullable(),
  proposedRewardRisk: finite.positive().nullable(),
  uncertainty: finite.min(0).max(1),
  abstentionReason: z.string().min(1).max(1000).nullable(),
  dataTimestamp: isoTime,
  expiresAt: isoTime,
}).strict();

export const MemoryEvidenceSchema = z.object({
  schemaVersion: version,
  evidenceId: z.string().uuid(),
  ruleVersion: z.string().min(1).max(120),
  state: z.enum(["observational", "shadow", "approved", "suspended", "retired"]),
  scope: z.object({
    strategyId: z.string().min(1).max(120).nullable(),
    regime: z.string().min(1).max(120).nullable(),
    symbolClass: z.string().min(1).max(120).nullable(),
    direction: z.enum(["long", "short"]).nullable(),
  }).strict(),
  sampleSize: finite.int().nonnegative(),
  estimate: finite,
  interval: z.object({ lower: finite, upper: finite, confidenceLevel: finite.min(0).max(1) }).strict(),
  permits: z.enum(["observe", "withhold", "reduce-risk"]),
  dataCutoff: isoTime,
  expiresAt: isoTime,
  fingerprint: hash,
}).strict().superRefine((value, ctx) => {
  if (value.interval.lower > value.interval.upper) {
    ctx.addIssue({ code: "custom", path: ["interval"], message: "lower must not exceed upper" });
  }
});

export const PortfolioContextSchema = z.object({
  schemaVersion: version,
  contextId: z.string().uuid(),
  asOf: isoTime,
  currency: z.string().min(3).max(12),
  equity: finite.nonnegative(),
  availableBalance: finite.nonnegative(),
  openPositionCount: finite.int().nonnegative(),
  remainingStopRisk: finite.nonnegative(),
  grossExposure: finite.nonnegative(),
  netExposure: finite,
  drawdownFraction: finite.min(0).max(1),
  reservedRisk: finite.nonnegative(),
  correlationState: z.enum(["known", "partial", "unknown"]),
  correlationClusters: z.array(z.object({
    clusterId: z.string().min(1),
    symbols: z.array(z.string().min(1)).min(1),
    exposure: finite.nonnegative(),
  }).strict()).max(100),
  riskPolicyVersion: z.string().min(1).max(120),
  fingerprint: hash,
}).strict();

export const TradeThesisSchema = z.object({
  schemaVersion: version,
  thesisId: z.string().uuid(),
  symbol: z.string().min(1).max(80),
  side: z.enum(["long", "short"]),
  context: z.string().min(1).max(3000),
  trigger: z.string().min(1).max(1000),
  invalidationConditions: z.array(z.string().min(1).max(500)).min(1).max(20),
  targetRationale: z.string().min(1).max(1000),
  expectedPath: z.array(z.string().min(1).max(500)).min(1).max(20),
  expectedDurationSeconds: finite.int().positive(),
  managementPolicyVersion: z.string().min(1).max(120),
}).strict();

export const ProposedTradePlanSchema = z.object({
  schemaVersion: version,
  strategyId: z.string().min(1).max(120),
  strategyName: z.string().min(1).max(200),
  symbol: z.string().min(1).max(80),
  side: z.enum(["long", "short"]),
  confidence: finite.min(0).max(100),
  entryPrice: finite.positive(),
  stopPrice: finite.positive(),
  targetPrice: finite.positive(),
  quantity: finite.positive(),
  leverage: finite.int().min(1),
  expectedHoldSeconds: finite.int().positive(),
  maxHoldSeconds: finite.int().positive(),
  regime: z.string().min(1).max(120),
  netRewardRisk: finite.positive().nullable(),
  report: z.object({
    summary: z.string().min(1),
    marketView: z.array(z.string()),
    entryLogic: z.array(z.string()),
    riskLogic: z.array(z.string()),
    exitLogic: z.array(z.string()),
    checks: z.array(z.object({ name: z.string(), passed: z.boolean(), detail: z.string() }).strict()),
    data: z.record(z.string(), z.unknown()).optional(),
  }).strict(),
}).strict().superRefine((value, ctx) => {
  const correctStop = value.side === "long" ? value.stopPrice < value.entryPrice : value.stopPrice > value.entryPrice;
  const correctTarget = value.side === "long" ? value.targetPrice > value.entryPrice : value.targetPrice < value.entryPrice;
  if (!correctStop) ctx.addIssue({ code: "custom", path: ["stopPrice"], message: "stop is on the wrong side of entry" });
  if (!correctTarget) ctx.addIssue({ code: "custom", path: ["targetPrice"], message: "target is on the wrong side of entry" });
  if (value.expectedHoldSeconds > value.maxHoldSeconds) {
    ctx.addIssue({ code: "custom", path: ["expectedHoldSeconds"], message: "must not exceed maxHoldSeconds" });
  }
});

export const BrainDecisionActionSchema = z.enum(["ENTER_NOW", "WAIT_FOR_TRIGGER", "OBSERVE", "REJECT", "REDUCE", "EXIT"]);

export const BrainDecisionSchema = z.object({
  schemaVersion: version,
  decisionId: z.string().uuid(),
  action: BrainDecisionActionSchema,
  symbol: z.string().min(1).max(80),
  marketStateFingerprint: hash,
  supportingEvidence: z.array(EvidenceReferenceSchema).max(100),
  opposingEvidence: z.array(EvidenceReferenceSchema).max(100),
  uncertainty: z.object({
    score: finite.min(0).max(1),
    reasons: z.array(z.string().min(1).max(500)).min(1).max(20),
    calibrated: z.boolean(),
  }).strict(),
  dataTimestamp: isoTime,
  expiresAt: isoTime,
  invalidationConditions: z.array(z.string().min(1).max(500)).min(1).max(20),
  versions: z.object({
    brain: z.string().min(1).max(120),
    strategy: z.string().min(1).max(120),
    model: z.string().min(1).max(120),
    config: z.string().min(1).max(120),
    marketState: z.string().min(1).max(120),
  }).strict(),
  reasonCode: z.string().regex(/^[A-Z0-9_]{3,120}$/),
  thesis: TradeThesisSchema.nullable(),
  proposedTrade: ProposedTradePlanSchema.nullable(),
}).strict().superRefine((value, ctx) => {
  if (Date.parse(value.expiresAt) <= Date.parse(value.dataTimestamp)) {
    ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "must be after dataTimestamp" });
  }
  if (value.action === "ENTER_NOW" && (!value.thesis || !value.proposedTrade)) {
    ctx.addIssue({ code: "custom", path: ["action"], message: "ENTER_NOW requires thesis and proposedTrade" });
  }
  const supporting = new Set(value.supportingEvidence.map((item) => item.evidenceId));
  for (const item of value.opposingEvidence) {
    if (supporting.has(item.evidenceId)) ctx.addIssue({ code: "custom", path: ["opposingEvidence"], message: "evidence cannot support and oppose the same decision" });
  }
});

export const RiskDecisionSchema = z.object({
  schemaVersion: version,
  riskDecisionId: z.string().uuid(),
  brainDecisionId: z.string().uuid(),
  verdict: z.enum(["APPROVE", "REDUCE", "REJECT"]),
  reasonCodes: z.array(z.string().regex(/^[A-Z0-9_]{3,120}$/)).min(1),
  approvedRiskAmount: finite.nonnegative(),
  approvedQuantity: finite.nonnegative(),
  policyVersion: z.string().min(1).max(120),
  evaluatedAt: isoTime,
  inputFingerprint: hash,
}).strict();

export const ExecutionCommandSchema = z.object({
  schemaVersion: version,
  commandId: z.string().uuid(),
  brainDecisionId: z.string().uuid(),
  riskDecisionId: z.string().uuid(),
  planFingerprint: hash,
  target: z.enum(["demo", "live"]),
  symbol: z.string().min(1).max(80),
  side: z.enum(["long", "short"]),
  quantity: finite.positive(),
  maximumIntendedLoss: finite.nonnegative(),
  authorizationReference: z.string().min(1).max(200),
  expiresAt: isoTime,
  idempotencyKey: z.string().min(16).max(200),
}).strict();

export type EvidenceReference = ReadonlyDeep<z.infer<typeof EvidenceReferenceSchema>>;
export type Opportunity = ReadonlyDeep<z.infer<typeof OpportunitySchema>>;
export type StrategyOpinion = ReadonlyDeep<z.infer<typeof StrategyOpinionSchema>>;
export type MemoryEvidence = ReadonlyDeep<z.infer<typeof MemoryEvidenceSchema>>;
export type PortfolioContext = ReadonlyDeep<z.infer<typeof PortfolioContextSchema>>;
export type TradeThesis = ReadonlyDeep<z.infer<typeof TradeThesisSchema>>;
export type ProposedTradePlan = ReadonlyDeep<z.infer<typeof ProposedTradePlanSchema>>;
export type BrainDecision = ReadonlyDeep<z.infer<typeof BrainDecisionSchema>>;
export type RiskDecision = ReadonlyDeep<z.infer<typeof RiskDecisionSchema>>;
export type ExecutionCommand = ReadonlyDeep<z.infer<typeof ExecutionCommandSchema>>;

export function parseBrainDecision(input: unknown): BrainDecision {
  return deepFreeze(BrainDecisionSchema.parse(input));
}

export function brainDecisionFingerprint(input: unknown): string {
  return sha256Fingerprint(parseBrainDecision(input));
}
