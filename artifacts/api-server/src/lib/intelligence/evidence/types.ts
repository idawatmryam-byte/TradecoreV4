import type { ReadonlyDeep } from "../canonical";

export const EVIDENCE_SCHEMA_VERSION = "evidence-v1" as const;
export const DEFAULT_EVIDENCE_HALF_LIFE_DAYS = 90;

export type EvidenceDimension =
  | "strategy_regime"
  | "symbol_strategy"
  | "symbol_class"
  | "direction"
  | "volatility"
  | "session"
  | "confidence_bucket"
  | "management_policy";

export type EvidencePermission = "observe" | "withhold" | "reduce-risk";
export type EvidenceLifecycleState = "observational" | "shadow" | "approved" | "active" | "suspended" | "retired";

export interface EvidenceScope {
  readonly dimension: EvidenceDimension;
  readonly key: string;
  readonly label: string;
  readonly strategyId: string | null;
  readonly regime: string | null;
  readonly symbol: string | null;
  readonly symbolClass: string | null;
  readonly direction: "long" | "short" | null;
  readonly volatility: string | null;
  readonly session: string | null;
  readonly confidenceBucket: string | null;
  readonly managementPolicy: string | null;
}

export interface NumericInterval {
  readonly lower: number;
  readonly upper: number;
  readonly confidenceLevel: 0.95;
}

export interface EvidenceOutcomeMetrics {
  readonly samples: number;
  readonly minimumSamples: number;
  readonly gated: boolean;
  readonly wins: number;
  readonly losses: number;
  readonly scratches: number;
  readonly winRate: number | null;
  readonly winRateInterval: NumericInterval | null;
  readonly grossPnlUsdt: number | null;
  readonly grossPnlCoverage: number;
  readonly feesUsdt: number | null;
  readonly slippageUsdt: number | null;
  readonly costCoverage: number;
  readonly netPnlUsdt: number;
  readonly expectancyUsdt: number | null;
  readonly expectancyInterval: NumericInterval | null;
  readonly profitFactor: number | null;
  readonly averageR: number | null;
  readonly averageRInterval: NumericInterval | null;
  readonly averageMaeUsdt: number | null;
  readonly averageMfeUsdt: number | null;
  readonly excursionCoverage: number;
  readonly averageTimeToMaeSeconds: number | null;
  readonly averageTimeToMfeSeconds: number | null;
  readonly excursionTimingCoverage: number;
}

export interface EvidenceStatistics {
  readonly baselineWinRate: number | null;
  readonly pValue: number | null;
  readonly qValue: number | null;
  readonly falseDiscoveryRate: number;
  readonly correction: "benjamini-hochberg";
  readonly significant: boolean;
  readonly effectDirection: "better" | "worse" | "indistinguishable" | "unknown";
}

export interface EvidenceDrift {
  readonly status: "stable" | "watch" | "degraded" | "insufficient_data";
  readonly referenceSamples: number;
  readonly recentSamples: number;
  readonly referenceWinRate: number | null;
  readonly recentWinRate: number | null;
  readonly absoluteShift: number | null;
  readonly intervalsOverlap: boolean | null;
  readonly reason: string;
}

export interface EvidenceRecord {
  readonly schemaVersion: typeof EVIDENCE_SCHEMA_VERSION;
  readonly evidenceId: string;
  readonly fingerprint: string;
  readonly lifecycle: "observational" | "shadow";
  readonly scope: EvidenceScope;
  readonly metrics: EvidenceOutcomeMetrics;
  readonly statistics: EvidenceStatistics;
  readonly drift: EvidenceDrift;
  readonly permission: EvidencePermission;
  readonly learnedStatement: string;
  readonly permittedBehavior: string;
  readonly dataCutoff: string;
  readonly latestOutcomeAt: string | null;
  readonly ageDays: number;
  readonly halfLifeDays: number;
  readonly decayWeight: number;
}

export interface EvidenceSnapshot {
  readonly schemaVersion: typeof EVIDENCE_SCHEMA_VERSION;
  readonly snapshotVersion: string;
  readonly fingerprint: string;
  readonly executionTarget: "demo" | "live";
  readonly generatedAt: string;
  readonly dataCutoff: string;
  readonly totalOutcomes: number;
  readonly minimumSamples: number;
  readonly falseDiscoveryRate: number;
  readonly cellsTested: number;
  readonly records: readonly EvidenceRecord[];
  readonly limitations: readonly string[];
}

export type FrozenEvidenceSnapshot = ReadonlyDeep<EvidenceSnapshot>;

export interface EvidenceRuleSetView {
  readonly ruleVersion: string;
  readonly status: EvidenceLifecycleState;
  readonly validationId: number;
  readonly executionTarget: "demo" | "live";
  readonly permits: "withhold" | "reduce-risk";
  readonly dataCutoff: string;
  readonly approvedAt: string | null;
  readonly activatedAt: string | null;
  readonly suspendedAt: string | null;
  readonly createdAt: string;
  readonly validation: unknown;
  readonly drift: unknown;
}
