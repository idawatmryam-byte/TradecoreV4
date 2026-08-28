interface AutopilotEnvironment {
  NODE_ENV?: string;
  AUTOPILOT_GLOBAL_SUSPENDED?: string;
}

export interface AutopilotDeploymentHardStop {
  active: boolean;
  configured: boolean;
  reason: string | null;
}

/**
 * Deployment control is an emergency hard stop, not the normal operator
 * workflow. An explicit true or malformed value blocks every Admin resume.
 * When absent/false, the persisted platform safety projection remains
 * authoritative and itself fails closed when unavailable or uninitialized.
 */
export function autopilotDeploymentHardStop(
  environment: AutopilotEnvironment = process.env,
): AutopilotDeploymentHardStop {
  const configured =
    environment.AUTOPILOT_GLOBAL_SUSPENDED?.trim().toLowerCase();
  if (!configured) return { active: false, configured: false, reason: null };
  if (["1", "true", "yes"].includes(configured)) {
    return {
      active: true,
      configured: true,
      reason: "The deployment emergency AutoPilot hard stop is active",
    };
  }
  if (["0", "false", "no"].includes(configured)) {
    return { active: false, configured: true, reason: null };
  }
  return {
    active: true,
    configured: true,
    reason: "The deployment emergency AutoPilot hard stop is malformed",
  };
}

/**
 * Production fails closed when the global suspension is absent or malformed.
 * An explicit false value is the only way a reviewed production deployment can
 * permit the remaining mandate and runtime gates to consider new Demo entries.
 */
export function globalAutopilotSuspended(
  environment: AutopilotEnvironment = process.env,
): boolean {
  const configured =
    environment.AUTOPILOT_GLOBAL_SUSPENDED?.trim().toLowerCase();
  if (!configured) return environment.NODE_ENV === "production";
  if (["1", "true", "yes"].includes(configured)) return true;
  if (["0", "false", "no"].includes(configured)) return false;
  return true;
}
