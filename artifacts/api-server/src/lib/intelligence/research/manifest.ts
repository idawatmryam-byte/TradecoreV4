import { sha256Fingerprint } from "../canonical";
import {
  RESEARCH_EXPERIMENT_VERSION,
  parseResearchExperimentManifest,
  type ResearchExperimentManifest,
  type ResearchPartitionPlan,
  type ResearchStressScenario,
} from "./types";

function deterministicUuid(value: unknown): string {
  const chars = sha256Fingerprint(value).slice(0, 32).split("");
  chars[12] = "5";
  chars[16] = ((Number.parseInt(chars[16]!, 16) & 0x3) | 0x8).toString(16);
  const hex = chars.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const DEFAULT_RESEARCH_STRESS_SCENARIOS = Object.freeze([
  {
    scenarioId: "base",
    label: "Recorded cost and fill assumptions",
    feeMultiplier: 1,
    slippageMultiplier: 1,
    spreadMultiplier: 1,
    latencyMs: 0,
    missingDataFraction: 0,
    adverseIntrabarOrdering: false,
  },
  {
    scenarioId: "costs-2x",
    label: "Fees, slippage, and spread doubled",
    feeMultiplier: 2,
    slippageMultiplier: 2,
    spreadMultiplier: 2,
    latencyMs: 0,
    missingDataFraction: 0,
    adverseIntrabarOrdering: false,
  },
  {
    scenarioId: "adverse-fill",
    label: "Adverse intrabar ordering with latency and missing data",
    feeMultiplier: 1,
    slippageMultiplier: 1.5,
    spreadMultiplier: 1.5,
    latencyMs: 5_000,
    missingDataFraction: 0.02,
    adverseIntrabarOrdering: true,
  },
] as const satisfies readonly ResearchStressScenario[]);

export interface BuildResearchManifestInput {
  name: string;
  controlManifestFingerprint: string;
  candidateBrainVersion: string;
  candidateConfig: unknown;
  candidateModel: unknown;
  narrativeMode: "deterministic-only" | "ai-observational";
  provider: "binance" | "oanda" | "fixture";
  marketType: "spot" | "futures" | "forex";
  symbols: readonly string[];
  timeframe: string;
  startInclusive: Date;
  endExclusive: Date;
  asOf: Date;
  dataFingerprint: string;
  syntheticDataAllowed: boolean;
  partitions: ResearchPartitionPlan;
  costs: ResearchExperimentManifest["costs"];
  versions: Omit<ResearchExperimentManifest["versions"], "sourceCodeHash">;
  sourceCode: unknown;
  deterministicSeed: number;
  stressScenarios?: readonly ResearchStressScenario[];
  falseDiscoveryRate?: number;
  hypothesesDeclaredBeforeRun?: number;
  createdAt: Date;
}

export function buildResearchExperimentManifest(
  input: BuildResearchManifestInput,
): ResearchExperimentManifest {
  const semanticCore = {
    schemaVersion: RESEARCH_EXPERIMENT_VERSION,
    mode: "research" as const,
    cannotExecute: true as const,
    control: {
      brainVersion: "brain-v0" as const,
      manifestFingerprint: input.controlManifestFingerprint,
    },
    candidate: {
      brainVersion: input.candidateBrainVersion,
      configFingerprint: sha256Fingerprint(input.candidateConfig),
      modelFingerprint: sha256Fingerprint(input.candidateModel),
      narrativeMode: input.narrativeMode,
    },
    data: {
      provider: input.provider,
      marketType: input.marketType,
      symbols: [
        ...new Set(input.symbols.map((symbol) => symbol.trim().toUpperCase())),
      ].sort(),
      timeframe: input.timeframe,
      window: {
        startInclusive: input.startInclusive.toISOString(),
        endExclusive: input.endExclusive.toISOString(),
      },
      asOf: input.asOf.toISOString(),
      dataFingerprint: input.dataFingerprint,
      syntheticDataAllowed: input.syntheticDataAllowed,
    },
    partitions: input.partitions,
    costs: input.costs,
    versions: {
      ...input.versions,
      sourceCodeHash: sha256Fingerprint(input.sourceCode),
    },
    stressScenarios: input.stressScenarios ?? DEFAULT_RESEARCH_STRESS_SCENARIOS,
    deterministicSeed: input.deterministicSeed,
    multipleTesting: {
      procedure: "benjamini-hochberg" as const,
      falseDiscoveryRate: input.falseDiscoveryRate ?? 0.05,
      hypothesesDeclaredBeforeRun: input.hypothesesDeclaredBeforeRun ?? 1,
    },
  };
  const fingerprint = sha256Fingerprint(semanticCore);
  return parseResearchExperimentManifest({
    ...semanticCore,
    experimentId: deterministicUuid({
      fingerprint,
      type: RESEARCH_EXPERIMENT_VERSION,
    }),
    name: input.name,
    createdAt: input.createdAt.toISOString(),
    fingerprint,
  });
}
