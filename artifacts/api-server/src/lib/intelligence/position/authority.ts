import type {
  PositionManagementAuthority,
  PositionManagementMode,
} from "./types";

export type ManagementEnvironment =
  | "research_shadow"
  | "demo"
  | "sandbox"
  | "live";

export interface ManagementAuthorityAssignment {
  readonly requestedMode: PositionManagementMode;
  readonly effectiveMode: PositionManagementMode;
  readonly authority: PositionManagementAuthority;
  readonly environment: ManagementEnvironment;
  readonly phase7Observes: boolean;
  readonly phase7MayMutate: boolean;
  readonly reasonCode: string;
}

export interface ResolveManagementAuthorityInput {
  requestedMode: PositionManagementMode;
  executionTarget: "demo" | "live";
  testnet: boolean;
  tradingMode: "research" | "copilot" | "autopilot";
}

export function resolveManagementAuthority(
  input: ResolveManagementAuthorityInput,
): ManagementAuthorityAssignment {
  const environment: ManagementEnvironment =
    input.tradingMode === "research"
      ? "research_shadow"
      : input.executionTarget === "demo"
        ? "demo"
        : input.testnet
          ? "sandbox"
          : "live";

  if (
    input.requestedMode === "phase7_active" &&
    (environment === "demo" || environment === "sandbox")
  ) {
    return {
      requestedMode: input.requestedMode,
      effectiveMode: "phase7_active",
      authority: "phase7",
      environment,
      phase7Observes: true,
      phase7MayMutate: true,
      reasonCode: "PHASE7_SANDBOX_AUTHORITY_GRANTED",
    };
  }

  if (
    input.requestedMode === "phase7_shadow" ||
    input.requestedMode === "phase7_active"
  ) {
    return {
      requestedMode: input.requestedMode,
      effectiveMode: "phase7_shadow",
      authority: "fixed",
      environment,
      phase7Observes: true,
      phase7MayMutate: false,
      reasonCode:
        environment === "live"
          ? "PHASE7_LIVE_AUTHORITY_DISABLED"
          : "PHASE7_OBSERVATION_ONLY",
    };
  }

  return {
    requestedMode: input.requestedMode,
    effectiveMode: "fixed",
    authority: "fixed",
    environment,
    phase7Observes: false,
    phase7MayMutate: false,
    reasonCode: "FIXED_MANAGEMENT_SELECTED",
  };
}
