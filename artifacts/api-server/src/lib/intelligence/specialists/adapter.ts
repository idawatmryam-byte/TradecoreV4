import { deepFreeze, sha256Fingerprint } from "../canonical";
import {
  INTELLIGENCE_SCHEMA_VERSION,
  StrategyOpinionSchema,
  type EvidenceReference,
  type StrategyOpinion,
} from "../contracts";
import type { MarketState } from "../market-state/types";
import type { Strategy, StrategyConfig, TradePlan, TradeRejection } from "../../strategies/base";
import {
  SPECIALIST_COUNCIL_VERSION,
  type MarketSpecialist,
  type SpecialistConsensus,
  type SpecialistCouncilSnapshot,
  type SpecialistEvaluationContext,
  type SpecialistOpinionView,
  type SpecialistRole,
} from "./types";

const SPECIALIST_VERSION = "strategy-adapter-v1";
const DISCOUNT_FACTORS = [1, 0.5, 0.25] as const;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function deterministicUuid(value: unknown): string {
  const chars = sha256Fingerprint(value).slice(0, 32).split("");
  chars[12] = "5";
  chars[16] = ((Number.parseInt(chars[16]!, 16) & 0x3) | 0x8).toString(16);
  const hex = chars.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function roleFor(strategyId: string): { role: SpecialistRole; correlationGroup: string } {
  switch (strategyId) {
    case "trend_pullback":
      return { role: "trend", correlationGroup: "trend-structure" };
    case "momentum_breakout":
      return { role: "breakout", correlationGroup: "momentum-breakout" };
    case "volatility_breakout":
      return { role: "volatility", correlationGroup: "volatility-breakout" };
    case "mean_reversion":
    case "vwap_reversion":
      return { role: "mean_reversion", correlationGroup: "price-reversion" };
    case "london_breakout":
      return { role: "breakout", correlationGroup: "session-breakout" };
    case "micro_scalping":
    case "scalp_reversion":
    case "twenty_min_momentum":
      return { role: "market_structure", correlationGroup: "short-horizon-price-action" };
    default:
      return { role: "market_structure", correlationGroup: `independent:${strategyId}` };
  }
}

function evidence(
  specialistId: string,
  marketState: MarketState,
  kind: EvidenceReference["kind"],
  summary: string,
  reference: string,
  strength: number,
): EvidenceReference {
  return {
    evidenceId: deterministicUuid({
      specialistId,
      marketStateFingerprint: marketState.fingerprint,
      kind,
      summary,
      reference,
    }),
    kind,
    source: specialistId,
    summary: summary.slice(0, 1000),
    reference: reference.slice(0, 500),
    fingerprint: marketState.fingerprint,
    dataTimestamp: marketState.dataTimestamp,
    strength: clamp01(strength),
  };
}

function planEvidence(
  specialistId: string,
  marketState: MarketState,
  plan: TradePlan,
): { supporting: EvidenceReference[]; opposing: EvidenceReference[] } {
  const strength = clamp01(plan.confidence / 100);
  const facts = [...plan.report.marketView, ...plan.report.entryLogic].slice(0, 50);
  const supporting = (facts.length > 0 ? facts : [plan.report.summary]).map((summary, index) =>
    evidence(
      specialistId,
      marketState,
      "specialist",
      summary,
      `market-state:${marketState.fingerprint}#supporting-${index}`,
      strength,
    ),
  );
  const opposing = plan.report.checks
    .filter((check) => !check.passed)
    .slice(0, 50)
    .map((check, index) =>
      evidence(
        specialistId,
        marketState,
        "specialist",
        `${check.name}: ${check.detail}`,
        `market-state:${marketState.fingerprint}#opposing-${index}`,
        1,
      ),
    );
  return { supporting, opposing };
}

export class StrategySpecialistAdapter implements MarketSpecialist {
  readonly specialistId: string;
  readonly specialistVersion = SPECIALIST_VERSION;
  readonly role: SpecialistRole;
  readonly correlationGroup: string;

  constructor(readonly strategy: Strategy) {
    this.specialistId = strategy.strategyId;
    const classification = roleFor(strategy.strategyId);
    this.role = classification.role;
    this.correlationGroup = classification.correlationGroup;
  }

  evaluate(marketState: MarketState, context: SpecialistEvaluationContext): StrategyOpinion {
    const { plan, rejection } = context;
    const strength = plan ? clamp01(plan.confidence / 100) : 0;
    const planRefs = plan ? planEvidence(this.specialistId, marketState, plan) : null;
    const opposingEvidence = rejection
      ? [
          evidence(
            this.specialistId,
            marketState,
            "specialist",
            rejection.reason,
            `market-state:${marketState.fingerprint}#rejection-${rejection.stage}`,
            clamp01((rejection.confidence ?? 100) / 100),
          ),
        ]
      : (planRefs?.opposing ?? []);

    const draft = {
      schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
      opinionId: deterministicUuid({
        specialistId: this.specialistId,
        specialistVersion: this.specialistVersion,
        marketStateFingerprint: marketState.fingerprint,
        plan: plan ?? null,
        rejection: rejection ?? null,
      }),
      specialistId: this.specialistId,
      specialistVersion: this.specialistVersion,
      marketStateFingerprint: marketState.fingerprint,
      symbol: marketState.symbol,
      stance: plan ? plan.side : "abstain",
      strength,
      applicableRegimes: [...this.strategy.supportedRegimes],
      supportingEvidence: planRefs?.supporting ?? [],
      opposingEvidence,
      trigger: plan ? (plan.report.entryLogic[0] ?? plan.report.summary) : null,
      invalidationConditions: plan
        ? [`Price reaches the proposed protective stop at ${plan.slPrice}`]
        : [],
      expectedDurationSeconds: plan ? plan.expectedHoldSeconds : null,
      proposedRewardRisk: plan?.netRewardRisk && plan.netRewardRisk > 0 ? plan.netRewardRisk : null,
      uncertainty: round(1 - strength),
      abstentionReason: plan ? null : (rejection?.reason ?? "No tradeable setup formed in this market snapshot"),
      dataTimestamp: marketState.dataTimestamp,
      expiresAt: context.expiresAt,
    };

    return deepFreeze(StrategyOpinionSchema.parse(draft));
  }
}

function discountCorrelatedOpinions(
  opinions: Array<{ adapter: StrategySpecialistAdapter; opinion: StrategyOpinion }>,
): SpecialistOpinionView[] {
  const ranks = new Map<string, number>();
  const actionable = opinions
    .filter(({ opinion }) => opinion.stance === "long" || opinion.stance === "short")
    .sort((a, b) => b.opinion.strength - a.opinion.strength || a.opinion.specialistId.localeCompare(b.opinion.specialistId));

  const discountById = new Map<string, number>();
  for (const item of actionable) {
    const key = `${item.adapter.correlationGroup}:${item.opinion.stance}`;
    const rank = ranks.get(key) ?? 0;
    ranks.set(key, rank + 1);
    discountById.set(item.opinion.opinionId, DISCOUNT_FACTORS[Math.min(rank, DISCOUNT_FACTORS.length - 1)]!);
  }

  return opinions
    .map(({ adapter, opinion }) => {
      const correlationDiscount = discountById.get(opinion.opinionId) ?? 1;
      return deepFreeze({
        role: adapter.role,
        correlationGroup: adapter.correlationGroup,
        correlationDiscount,
        effectiveStrength: round(opinion.strength * correlationDiscount),
        operationalStatus: opinion.stance === "abstain" ? "abstained" as const : "active" as const,
        opinion,
      });
    })
    .sort((a, b) => a.opinion.specialistId.localeCompare(b.opinion.specialistId));
}

function consensusOf(opinions: readonly SpecialistOpinionView[]): SpecialistConsensus {
  const longScore = round(opinions
    .filter((item) => item.opinion.stance === "long")
    .reduce((sum, item) => sum + item.effectiveStrength, 0));
  const shortScore = round(opinions
    .filter((item) => item.opinion.stance === "short")
    .reduce((sum, item) => sum + item.effectiveStrength, 0));
  const actionableOpinions = opinions.filter((item) => item.operationalStatus === "active").length;
  const abstentions = opinions.length - actionableOpinions;
  const high = Math.max(longScore, shortScore);
  const low = Math.min(longScore, shortScore);
  const disagreement = high > 0 && low / high >= 0.35;
  const stance = actionableOpinions === 0
    ? "abstain" as const
    : disagreement
      ? "mixed" as const
      : longScore >= shortScore
        ? "long" as const
        : "short" as const;
  const explanation = stance === "abstain"
    ? "Every eligible specialist abstained on this snapshot."
    : stance === "mixed"
      ? `Specialists disagree after correlation discounting (long ${longScore}, short ${shortScore}).`
      : `${stance === "long" ? "Long" : "Short"} specialists lead after correlation discounting (long ${longScore}, short ${shortScore}).`;

  return deepFreeze({
    stance,
    longScore,
    shortScore,
    actionableOpinions,
    abstentions,
    disagreement,
    explanation,
  });
}

export interface BuildSpecialistCouncilInput {
  readonly marketState: MarketState;
  readonly strategies: readonly Strategy[];
  readonly configs: ReadonlyMap<string, StrategyConfig>;
  readonly plans: readonly TradePlan[];
  readonly rejections: readonly TradeRejection[];
  readonly generatedAt: Date;
}

export function buildSpecialistCouncilSnapshot(input: BuildSpecialistCouncilInput): SpecialistCouncilSnapshot {
  const generatedAt = input.generatedAt.toISOString();
  const configured = input.strategies
    .filter((strategy) => {
      const config = input.configs.get(strategy.strategyId);
      return Boolean(config?.enabled) && strategy.supportedRegimes.includes(input.marketState.inferences.regime);
    })
    .map((strategy) => {
      const config = input.configs.get(strategy.strategyId)!;
      const adapter = new StrategySpecialistAdapter(strategy);
      const plan = input.plans.find((candidate) => candidate.strategyId === strategy.strategyId) ?? null;
      const rejection = input.rejections.find((candidate) => candidate.strategyId === strategy.strategyId) ?? null;
      const expiryMs = Math.min(config.maxHoldingSeconds * 1000, 15 * 60_000);
      const context: SpecialistEvaluationContext = {
        strategy,
        config,
        plan,
        rejection,
        generatedAt,
        expiresAt: new Date(input.generatedAt.getTime() + Math.max(1_000, expiryMs)).toISOString(),
      };
      return { adapter, opinion: adapter.evaluate(input.marketState, context) };
    });

  const opinions = discountCorrelatedOpinions(configured);
  return deepFreeze({
    schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
    councilVersion: SPECIALIST_COUNCIL_VERSION,
    mode: "observational",
    cannotExecute: true,
    symbol: input.marketState.symbol,
    marketStateFingerprint: input.marketState.fingerprint,
    dataTimestamp: input.marketState.dataTimestamp,
    generatedAt,
    consensus: consensusOf(opinions),
    opinions,
  });
}
