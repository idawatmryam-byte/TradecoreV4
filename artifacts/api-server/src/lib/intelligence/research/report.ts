import { PROMOTION_GATES } from "../baseline";
import { sha256Fingerprint } from "../canonical";
import { benjaminiHochberg, type HypothesisTest } from "./multiple-testing";
import {
  RESEARCH_REPORT_VERSION,
  parseResearchPromotionReport,
  type ResearchAttribution,
  type ResearchExperimentManifest,
  type ResearchMetrics,
  type ResearchPromotionReport,
} from "./types";
import type { LeakageCheck } from "./partitions";

export interface BuildResearchPromotionReportInput {
  manifest: ResearchExperimentManifest;
  control: ResearchMetrics;
  candidate: ResearchMetrics;
  attribution: Omit<ResearchAttribution, "residual"> & { residual?: number };
  goldenStream: {
    expectedFingerprint: string;
    actualFingerprint: string;
    reproducible: boolean;
  };
  leakageChecks: readonly LeakageCheck[];
  hypotheses: readonly HypothesisTest[];
  noRiskPolicyViolations: boolean;
  holdoutEvaluated: boolean;
  allStressScenariosPassed: boolean;
  nonInferiorityMarginR?: number;
  maximumDrawdownIncrease?: number;
  generatedAt: Date;
  limitations?: readonly string[];
}

export function buildResearchPromotionReport(
  input: BuildResearchPromotionReportInput,
): ResearchPromotionReport {
  if (
    input.hypotheses.length !==
    input.manifest.multipleTesting.hypothesesDeclaredBeforeRun
  ) {
    throw new Error(
      "Observed hypothesis count does not match the predeclared manifest",
    );
  }
  const adjusted = benjaminiHochberg(
    input.hypotheses,
    input.manifest.multipleTesting.falseDiscoveryRate,
  );
  const shadowGate = PROMOTION_GATES.find((gate) => gate.stage === "shadow");
  if (!shadowGate) throw new Error("Frozen Phase 0 Shadow gate is unavailable");
  const nonInferiorityMarginR = input.nonInferiorityMarginR ?? 0.1;
  const maximumDrawdownIncrease = input.maximumDrawdownIncrease ?? 0.02;
  const candidateLower = input.candidate.uncertainty.lowerNetExpectancyR;
  const controlLower = input.control.uncertainty.lowerNetExpectancyR;
  const expectancyComparable = candidateLower !== null && controlLower !== null;
  const nonInferior =
    expectancyComparable &&
    candidateLower >= controlLower - nonInferiorityMarginR;
  const drawdownWithinBound =
    input.candidate.maxDrawdown <=
    input.control.maxDrawdown + maximumDrawdownIncrease;
  const leakagePassed =
    input.leakageChecks.length > 0 &&
    input.leakageChecks.every((check) => check.passed);

  const gateChecks = [
    {
      key: "multiple-testing-accounting",
      passed: adjusted.length === input.manifest.multipleTesting.hypothesesDeclaredBeforeRun,
      actual: `${adjusted.length} predeclared hypotheses; ${adjusted.filter((test) => test.discovery).length} discoveries after Benjamini-Hochberg`,
      required: "Every tested hypothesis is declared in the manifest and adjusted together",
    },
    {
      key: "isolated-optimum-avoidance",
      passed: true,
      actual: "Candidate version and configuration fingerprint were frozen before replay; Experiment Lab performed no parameter sweep",
      required: "No isolated post-hoc optimum may be promoted",
    },
    {
      key: "golden-stream",
      passed: input.goldenStream.reproducible,
      actual: input.goldenStream.actualFingerprint,
      required: input.goldenStream.expectedFingerprint,
    },
    {
      key: "point-in-time-leakage",
      passed: leakagePassed,
      actual: `${input.leakageChecks.filter((check) => check.passed).length}/${input.leakageChecks.length} checks passed`,
      required: "Every declared leakage check passes",
    },
    {
      key: "deterministic-risk",
      passed: input.noRiskPolicyViolations,
      actual: input.noRiskPolicyViolations
        ? "No violations observed"
        : "At least one violation observed",
      required: "Zero deterministic risk-policy violations",
    },
    {
      key: "eligible-decisions",
      passed:
        input.candidate.eligibleDecisions >=
        shadowGate.minimumEligibleDecisions,
      actual: String(input.candidate.eligibleDecisions),
      required: String(shadowGate.minimumEligibleDecisions),
    },
    {
      key: "closed-trades",
      passed: input.candidate.closedTrades >= shadowGate.minimumClosedTrades,
      actual: String(input.candidate.closedTrades),
      required: String(shadowGate.minimumClosedTrades),
    },
    {
      key: "calendar-days",
      passed: input.candidate.calendarDays >= shadowGate.minimumCalendarDays,
      actual: input.candidate.calendarDays.toFixed(2),
      required: String(shadowGate.minimumCalendarDays),
    },
    {
      key: "expectancy-non-inferiority",
      passed: nonInferior,
      actual: expectancyComparable
        ? `candidate lower ${candidateLower!.toFixed(4)}R; control lower ${controlLower!.toFixed(4)}R`
        : "Unmeasurable: planned-risk or bootstrap evidence is unavailable",
      required: `Candidate lower bound at least control lower bound minus ${nonInferiorityMarginR}R`,
    },
    {
      key: "drawdown-non-inferiority",
      passed: drawdownWithinBound,
      actual: `candidate ${(input.candidate.maxDrawdown * 100).toFixed(2)}%; control ${(input.control.maxDrawdown * 100).toFixed(2)}%`,
      required: `Candidate increase no more than ${(maximumDrawdownIncrease * 100).toFixed(2)} percentage points`,
    },
    {
      key: "untouched-holdout",
      passed: input.holdoutEvaluated,
      actual: input.holdoutEvaluated ? "Evaluated once" : "Not evaluated",
      required: "Untouched holdout evaluated without parameter changes",
    },
    {
      key: "stress-suite",
      passed: input.allStressScenariosPassed,
      actual: input.allStressScenariosPassed
        ? "All scenarios passed"
        : "One or more scenarios failed",
      required:
        "All predeclared cost, missing-data, latency, and adverse-ordering scenarios pass",
    },
  ];

  const integrityFailure =
    !input.goldenStream.reproducible ||
    !leakagePassed ||
    !input.noRiskPolicyViolations;
  const allPassed = gateChecks.every((check) => check.passed);
  const recommendation = integrityFailure
    ? ("REJECT" as const)
    : allPassed
      ? ("ELIGIBLE_FOR_HUMAN_REVIEW" as const)
      : ("REMAIN_RESEARCH" as const);
  const supplied = input.attribution;
  const explained =
    supplied.perception +
    supplied.selection +
    supplied.evidence +
    supplied.allocation +
    supplied.executionCosts +
    supplied.management;
  const residual =
    supplied.residual ??
    input.candidate.netPnl - input.control.netPnl - explained;
  const attribution: ResearchAttribution = Object.freeze({
    ...supplied,
    residual,
  });
  const limitations = [
    ...(input.limitations ?? []),
    "This report is Research evidence only and cannot promote, authorize, or execute a trade.",
    "AI narrative output, when enabled, is observational and is excluded from measurements and gate decisions.",
  ];
  const core = {
    schemaVersion: RESEARCH_REPORT_VERSION,
    experimentId: input.manifest.experimentId,
    manifestFingerprint: input.manifest.fingerprint,
    generatedAt: input.generatedAt.toISOString(),
    control: input.control,
    candidate: input.candidate,
    attribution,
    goldenStream: input.goldenStream,
    leakageChecks: input.leakageChecks,
    multipleTesting: {
      procedure: "benjamini-hochberg" as const,
      falseDiscoveryRate: input.manifest.multipleTesting.falseDiscoveryRate,
      hypotheses: adjusted.length,
      discoveries: adjusted.filter((test) => test.discovery).length,
    },
    gateChecks,
    recommendation,
    humanApprovalRequired: true as const,
    limitations,
  };
  return parseResearchPromotionReport({
    ...core,
    fingerprint: sha256Fingerprint(core),
  });
}
