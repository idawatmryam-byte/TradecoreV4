export type AssignmentPolicyMode = "research" | "copilot" | "autopilot";

export interface AssignmentPolicyView {
  strategyId: string;
  brain: boolean;
  copilot: boolean;
  autopilot: boolean;
}

/**
 * Brain and Co-Pilot consume the desired assignment set. AutoPilot deliberately
 * returns the original configuration map because an active immutable mandate,
 * not a UI preference, is the executable authority.
 */
export function applyStrategyAssignmentPolicy<T extends { enabled: boolean }>(
  mode: AssignmentPolicyMode,
  configs: ReadonlyMap<string, T>,
  assignments: readonly AssignmentPolicyView[],
): Map<string, T> {
  if (mode === "autopilot") return new Map(configs);
  const allowed = new Map(
    assignments.map((assignment) => [
      assignment.strategyId,
      mode === "research" ? assignment.brain : assignment.copilot,
    ]),
  );
  return new Map(
    [...configs].map(([strategyId, config]) => [
      strategyId,
      { ...config, enabled: config.enabled && allowed.get(strategyId) === true },
    ]),
  );
}
