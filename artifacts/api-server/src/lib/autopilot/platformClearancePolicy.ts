export type PlatformAutopilotClearance = {
  clearanceId: string;
  state: "PENDING" | "ACTIVE" | "EXPIRED" | "REVOKED";
  requestedByUserId: number;
  approvedByUserId: number | null;
  revokedByUserId: number | null;
  reason: string;
  durationMinutes: number;
  requestedAt: string;
  approvedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
};

export type PlatformAutopilotGate = {
  effectiveSuspended: boolean;
  deploymentSuspended: boolean;
  clearanceRequired: boolean;
  reasonCode:
    | "DEPLOYMENT_SUSPENSION_ACTIVE"
    | "ADMIN_CLEARANCE_REQUIRED"
    | "ADMIN_CLEARANCE_UNAVAILABLE"
    | "PLATFORM_GATE_CLEAR";
  clearance: PlatformAutopilotClearance | null;
};

export function resolvePlatformAutopilotGate(input: {
  deploymentSuspended: boolean;
  clearanceRequired: boolean;
  clearanceAvailable: boolean;
  clearance: PlatformAutopilotClearance | null;
}): PlatformAutopilotGate {
  if (!input.clearanceRequired) {
    return {
      effectiveSuspended: input.deploymentSuspended,
      deploymentSuspended: input.deploymentSuspended,
      clearanceRequired: false,
      reasonCode: input.deploymentSuspended
        ? "DEPLOYMENT_SUSPENSION_ACTIVE"
        : "PLATFORM_GATE_CLEAR",
      clearance: null,
    };
  }
  if (input.deploymentSuspended) {
    return {
      effectiveSuspended: true,
      deploymentSuspended: true,
      clearanceRequired: true,
      reasonCode: "DEPLOYMENT_SUSPENSION_ACTIVE",
      clearance: input.clearance,
    };
  }
  if (!input.clearanceAvailable) {
    return {
      effectiveSuspended: true,
      deploymentSuspended: false,
      clearanceRequired: true,
      reasonCode: "ADMIN_CLEARANCE_UNAVAILABLE",
      clearance: null,
    };
  }
  return {
    effectiveSuspended: input.clearance?.state !== "ACTIVE",
    deploymentSuspended: false,
    clearanceRequired: true,
    reasonCode:
      input.clearance?.state === "ACTIVE"
        ? "PLATFORM_GATE_CLEAR"
        : "ADMIN_CLEARANCE_REQUIRED",
    clearance: input.clearance,
  };
}
