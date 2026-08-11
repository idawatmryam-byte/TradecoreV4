import type { EngineResumeHealth } from "./startupHealth";

export type ReadinessReason =
  | "ready"
  | "database_unhealthy"
  | "engine_resume_pending"
  | "engine_resume_failed";

export function readinessState(
  databaseHealthy: boolean,
  engineResume: EngineResumeHealth,
): { ready: boolean; reason: ReadinessReason } {
  if (!databaseHealthy) return { ready: false, reason: "database_unhealthy" };
  if (engineResume.status === "pending")
    return { ready: false, reason: "engine_resume_pending" };
  if (engineResume.status === "degraded")
    return { ready: false, reason: "engine_resume_failed" };
  return { ready: true, reason: "ready" };
}
