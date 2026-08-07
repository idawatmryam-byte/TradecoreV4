import { INTELLIGENCE_SCHEMA_VERSION } from "../contracts";
import { deepFreeze, sha256Fingerprint } from "../canonical";
import { aggregateDecisionCouncil } from "./deterministic";
import { CouncilReasoningGateway, type ReasoningGatewayOptions, type ReasoningProvider } from "./reasoning";
import {
  DECISION_COUNCIL_VERSION,
  type EvaluateDecisionCouncilInput,
  type ShadowCouncilRun,
} from "./types";

const MAX_CACHED_RUNS = 500;

function deterministicUuid(value: unknown): string {
  const chars = sha256Fingerprint(value).slice(0, 32).split("");
  chars[12] = "5";
  chars[16] = ((Number.parseInt(chars[16]!, 16) & 0x3) | 0x8).toString(16);
  const hex = chars.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Shadow-only orchestration boundary. This module intentionally imports no
 * executor, broker adapter, risk approval, or ExecutionCommand type.
 */
export class DecisionCouncil {
  private readonly reasoning: CouncilReasoningGateway;
  private readonly cache = new Map<string, Promise<ShadowCouncilRun>>();

  constructor(provider: ReasoningProvider | null = null, options: ReasoningGatewayOptions = {}) {
    this.reasoning = new CouncilReasoningGateway(provider, options);
  }

  evaluate(input: EvaluateDecisionCouncilInput): Promise<ShadowCouncilRun> {
    const deterministic = aggregateDecisionCouncil(input);
    const cached = this.cache.get(deterministic.inputFingerprint);
    if (cached) return cached;

    const pending = this.createRun(input, deterministic);
    this.cache.set(deterministic.inputFingerprint, pending);
    if (this.cache.size > MAX_CACHED_RUNS) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest) this.cache.delete(oldest);
    }
    pending.catch(() => this.cache.delete(deterministic.inputFingerprint));
    return pending;
  }

  private async createRun(
    input: EvaluateDecisionCouncilInput,
    deterministic: ReturnType<typeof aggregateDecisionCouncil>,
  ): Promise<ShadowCouncilRun> {
    const reasoning = await this.reasoning.review(deterministic.decision, deterministic.knownEvidence);
    const runId = deterministicUuid({
      councilVersion: DECISION_COUNCIL_VERSION,
      inputFingerprint: deterministic.inputFingerprint,
    });
    const replay = {
      marketState: input.marketState,
      specialistCouncil: input.specialistCouncil,
      executionCosts: input.executionCosts,
      portfolio: input.portfolio,
      historicalEvidence: input.historicalEvidence,
      brainV0: deterministic.brainV0,
    } as const;
    const runFingerprint = sha256Fingerprint({
      runId,
      inputFingerprint: deterministic.inputFingerprint,
      decisionFingerprint: deterministic.decisionFingerprint,
      assessment: deterministic.assessment,
      reasoning,
      replay,
    });
    return deepFreeze({
      schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
      councilVersion: DECISION_COUNCIL_VERSION,
      runId,
      inputFingerprint: deterministic.inputFingerprint,
      runFingerprint,
      mode: "shadow",
      cannotExecute: true,
      generatedAt: input.generatedAt,
      decision: deterministic.decision,
      decisionFingerprint: deterministic.decisionFingerprint,
      deterministicAssessment: deterministic.assessment,
      reasoning,
      replay,
    });
  }
}

