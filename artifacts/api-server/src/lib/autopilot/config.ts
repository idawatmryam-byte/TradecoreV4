interface AutopilotEnvironment {
  NODE_ENV?: string;
  AUTOPILOT_GLOBAL_SUSPENDED?: string;
}

/**
 * Production fails closed when the global suspension is absent or malformed.
 * An explicit false value is the only way a reviewed production deployment can
 * permit the remaining mandate and runtime gates to consider new Demo entries.
 */
export function globalAutopilotSuspended(environment: AutopilotEnvironment = process.env): boolean {
  const configured = environment.AUTOPILOT_GLOBAL_SUSPENDED?.trim().toLowerCase();
  if (!configured) return environment.NODE_ENV === "production";
  if (["1", "true", "yes"].includes(configured)) return true;
  if (["0", "false", "no"].includes(configured)) return false;
  return true;
}
