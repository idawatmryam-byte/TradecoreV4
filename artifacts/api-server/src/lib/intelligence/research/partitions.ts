import { sha256Fingerprint } from "../canonical";
import {
  RESEARCH_PARTITION_VERSION,
  parseResearchPartitionPlan,
  type ResearchPartitionPlan,
  type ResearchWindow,
} from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface BuildPurgedWalkForwardPlanInput {
  startInclusive: Date;
  endExclusive: Date;
  folds: number;
  holdoutFraction: number;
  purgeMs: number;
  embargoMs: number;
  minimumTrainMs?: number;
  minimumValidationMs?: number;
}

function asWindow(start: number, end: number): ResearchWindow {
  return {
    startInclusive: new Date(start).toISOString(),
    endExclusive: new Date(end).toISOString(),
  };
}

export function buildPurgedWalkForwardPlan(
  input: BuildPurgedWalkForwardPlanInput,
): ResearchPartitionPlan {
  const start = input.startInclusive.getTime();
  const end = input.endExclusive.getTime();
  const folds = Math.floor(input.folds);
  const minimumTrainMs = input.minimumTrainMs ?? 7 * DAY_MS;
  const minimumValidationMs = input.minimumValidationMs ?? DAY_MS;

  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    throw new Error("Research partition range is invalid");
  }
  if (!Number.isInteger(folds) || folds < 1 || folds > 20) {
    throw new Error("Research folds must be an integer from 1 to 20");
  }
  if (!(input.holdoutFraction >= 0.1 && input.holdoutFraction <= 0.5)) {
    throw new Error("Untouched holdout fraction must be between 0.1 and 0.5");
  }
  if (
    !Number.isFinite(input.purgeMs) ||
    !Number.isFinite(input.embargoMs) ||
    input.purgeMs < 0 ||
    input.embargoMs < 0
  ) {
    throw new Error("Purge and embargo durations must be non-negative");
  }

  const totalMs = end - start;
  const holdoutStart = Math.floor(end - totalMs * input.holdoutFraction);
  const developmentMs = holdoutStart - start;
  const validationMs = Math.floor(developmentMs / (folds + 1));
  if (validationMs < minimumValidationMs) {
    throw new Error(
      "Research window is too short for the requested validation folds",
    );
  }

  const plannedFolds = Array.from({ length: folds }, (_, index) => {
    const split = start + validationMs * (index + 1);
    const trainEnd = split - input.purgeMs;
    const validationStart = split + input.embargoMs;
    const validationEnd = split + validationMs;
    if (trainEnd - start < minimumTrainMs) {
      throw new Error(
        `Fold ${index + 1} has less than the minimum training history`,
      );
    }
    if (validationEnd - validationStart < minimumValidationMs) {
      throw new Error(
        `Fold ${index + 1} has less than the minimum validation history after embargo`,
      );
    }
    return {
      foldId: `fold-${index + 1}`,
      train: asWindow(start, trainEnd),
      validation: asWindow(validationStart, validationEnd),
      purgeMs: input.purgeMs,
      embargoMs: input.embargoMs,
    };
  });

  const core = {
    version: RESEARCH_PARTITION_VERSION,
    method: "expanding-window" as const,
    folds: plannedFolds,
    untouchedHoldout: asWindow(holdoutStart, end),
  };
  return parseResearchPartitionPlan({
    ...core,
    fingerprint: sha256Fingerprint(core),
  });
}

export interface PointInTimeObservation {
  featureTimestamp: string;
  labelTimestamp?: string | null;
  universeTimestamp?: string | null;
  regimeTimestamp?: string | null;
  evidenceAsOf?: string | null;
}

export interface LeakageCheck {
  check: string;
  passed: boolean;
  detail: string;
}

export function verifyPointInTimeObservation(
  decisionTimestamp: string,
  observation: PointInTimeObservation,
): readonly LeakageCheck[] {
  const decision = Date.parse(decisionTimestamp);
  if (!Number.isFinite(decision))
    throw new Error("Decision timestamp is invalid");
  const checks: LeakageCheck[] = [];
  const atOrBefore = (label: string, value: string | null | undefined) => {
    if (!value) {
      checks.push({
        check: label,
        passed: true,
        detail: `${label} was unavailable and therefore could not influence the decision.`,
      });
      return;
    }
    const timestamp = Date.parse(value);
    checks.push({
      check: label,
      passed: Number.isFinite(timestamp) && timestamp <= decision,
      detail: Number.isFinite(timestamp)
        ? `${label} timestamp ${value} was compared with decision time ${decisionTimestamp}.`
        : `${label} timestamp is invalid.`,
    });
  };

  atOrBefore("feature-time", observation.featureTimestamp);
  atOrBefore("universe-membership-time", observation.universeTimestamp);
  atOrBefore("regime-time", observation.regimeTimestamp);
  atOrBefore("evidence-as-of", observation.evidenceAsOf);

  if (!observation.labelTimestamp) {
    checks.push({
      check: "future-label-isolation",
      passed: true,
      detail: "No outcome label was present at decision time.",
    });
  } else {
    const label = Date.parse(observation.labelTimestamp);
    checks.push({
      check: "future-label-isolation",
      passed: Number.isFinite(label) && label > decision,
      detail: Number.isFinite(label)
        ? `Outcome label time ${observation.labelTimestamp} must be strictly after decision time ${decisionTimestamp}.`
        : "Outcome label timestamp is invalid.",
    });
  }
  return Object.freeze(checks.map((check) => Object.freeze(check)));
}

export function partitionForTimestamp(
  plan: ResearchPartitionPlan,
  timestamp: string,
): string | null {
  const value = Date.parse(timestamp);
  if (!Number.isFinite(value)) return null;
  for (const fold of plan.folds) {
    const validationStart = Date.parse(fold.validation.startInclusive);
    const validationEnd = Date.parse(fold.validation.endExclusive);
    if (value >= validationStart && value < validationEnd) return fold.foldId;
  }
  const holdoutStart = Date.parse(plan.untouchedHoldout.startInclusive);
  const holdoutEnd = Date.parse(plan.untouchedHoldout.endExclusive);
  return value >= holdoutStart && value < holdoutEnd
    ? "untouched-holdout"
    : null;
}
