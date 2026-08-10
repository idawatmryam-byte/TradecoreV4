import { sha256Fingerprint } from "../intelligence/canonical";
import type { MarketState } from "../intelligence/market-state/types";
import type { ShadowCouncilRun } from "../intelligence/council";
import type { SpecialistCouncilSnapshot } from "../intelligence/specialists";
import type { PortfolioIntelligenceProjection } from "../intelligence/portfolio";
import type { ManagementAuthorityAssignment } from "../intelligence/position";
import type { RiskCheck } from "../decisionTrace";

export const COPILOT_BUNDLE_VERSION = "phase9-copilot-bundle-v1" as const;
export const COPILOT_APPROVAL_POLICY_VERSION =
  "phase9-human-approval-v1" as const;
export const COPILOT_REVALIDATION_POLICY_VERSION =
  "phase9-revalidation-v1" as const;

export interface CreationRiskSnapshot {
  readonly verdict: "PASSED";
  readonly checks: readonly RiskCheck[];
  readonly candidateMaximumLoss: number;
  readonly candidateNotional: number;
  readonly policyVersion: string;
}

export interface Phase9DecisionBundle {
  readonly schemaVersion: typeof COPILOT_BUNDLE_VERSION;
  readonly createdAt: string;
  readonly planFingerprint: string;
  readonly executionTarget: "demo" | "live";
  readonly tradingMode: "copilot";
  readonly authorizationScope: "single-controlled-execution-attempt";
  readonly approvalPolicyVersion: typeof COPILOT_APPROVAL_POLICY_VERSION;
  readonly revalidationPolicyVersion: typeof COPILOT_REVALIDATION_POLICY_VERSION;
  readonly decisionAuthority: "brain-v0";
  readonly unifiedBrain: {
    readonly status: "shadow_context";
    readonly reason: string;
    readonly run: ShadowCouncilRun;
  };
  readonly marketState: MarketState;
  readonly specialistCouncil: SpecialistCouncilSnapshot;
  readonly portfolio: PortfolioIntelligenceProjection;
  readonly risk: CreationRiskSnapshot;
  readonly managementAuthority: ManagementAuthorityAssignment | null;
  readonly versions: {
    readonly plan: string;
    readonly brain: string;
    readonly council: string;
    readonly marketState: string;
    readonly portfolio: string;
    readonly riskPolicy: string;
    readonly managementPolicy: string | null;
  };
  readonly limitations: readonly string[];
}

export function fingerprintDecisionBundle(
  bundle: Phase9DecisionBundle,
): string {
  return sha256Fingerprint(bundle);
}

export function isPhase9DecisionBundle(
  value: unknown,
): value is Phase9DecisionBundle {
  if (!value || typeof value !== "object") return false;
  const bundle = value as Partial<Phase9DecisionBundle>;
  return (
    bundle.schemaVersion === COPILOT_BUNDLE_VERSION &&
    bundle.tradingMode === "copilot" &&
    (bundle.executionTarget === "demo" || bundle.executionTarget === "live") &&
    typeof bundle.planFingerprint === "string" &&
    bundle.authorizationScope === "single-controlled-execution-attempt" &&
    bundle.unifiedBrain?.status === "shadow_context" &&
    bundle.decisionAuthority === "brain-v0"
  );
}
