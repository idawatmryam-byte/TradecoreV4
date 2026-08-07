export const PROMOTION_CONFIRMATION = "APPROVE_WITHHOLD_ONLY" as const;
export const ROLLBACK_CONFIRMATION = "ROLLBACK_TO_VALIDATED_VERSION" as const;

export type RuleSetStatus = "shadow" | "approved" | "active" | "suspended" | "retired";

export interface PromotionCandidate {
  readonly status: RuleSetStatus;
  readonly verdict: "improved" | "no_better" | "insufficient_data";
  readonly permits: "withhold" | "reduce-risk";
  readonly driftStatus: "stable" | "watch" | "degraded" | "insufficient_data";
  readonly validationTrades: number;
  readonly minimumValidationTrades: number;
}

export interface LifecycleDecision {
  readonly allowed: boolean;
  readonly nextStatus: RuleSetStatus;
  readonly reason: string;
}

/** Pure promotion gate shared by the API service and the harness. */
export function promotionDecision(candidate: PromotionCandidate, confirmation: string): LifecycleDecision {
  if (confirmation !== PROMOTION_CONFIRMATION) {
    return { allowed: false, nextStatus: candidate.status, reason: "Explicit withhold-only confirmation is required." };
  }
  if (candidate.status !== "shadow" && candidate.status !== "approved") {
    return { allowed: false, nextStatus: candidate.status, reason: `A ${candidate.status} version cannot be promoted.` };
  }
  if (candidate.verdict !== "improved") {
    return { allowed: false, nextStatus: candidate.status, reason: "Only an out-of-sample improved verdict can be promoted." };
  }
  if (candidate.validationTrades < candidate.minimumValidationTrades) {
    return { allowed: false, nextStatus: candidate.status, reason: "The validation sample is below the predetermined minimum." };
  }
  if (candidate.driftStatus === "degraded") {
    return { allowed: false, nextStatus: candidate.status, reason: "Degraded evidence must be revalidated before promotion." };
  }
  if (candidate.permits !== "withhold" && candidate.permits !== "reduce-risk") {
    return { allowed: false, nextStatus: candidate.status, reason: "Evidence may only withhold or reduce risk." };
  }
  return {
    allowed: true,
    nextStatus: "active",
    reason: "Validated evidence may activate within its tightening-only permission.",
  };
}

export function rollbackDecision(candidate: PromotionCandidate, confirmation: string): LifecycleDecision {
  if (confirmation !== ROLLBACK_CONFIRMATION) {
    return { allowed: false, nextStatus: candidate.status, reason: "Explicit rollback confirmation is required." };
  }
  if (!(["approved", "suspended", "retired"] as RuleSetStatus[]).includes(candidate.status)) {
    return { allowed: false, nextStatus: candidate.status, reason: `A ${candidate.status} version is not a rollback target.` };
  }
  return promotionDecision({ ...candidate, status: "approved" }, PROMOTION_CONFIRMATION);
}
