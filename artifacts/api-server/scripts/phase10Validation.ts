import {
  confirmPhase10ValidationGlobalSuspension,
  runPhase10ValidationAfterRestart,
  runPhase10ValidationBeforeRestart,
} from "../src/lib/autopilot/validationRunner";
import {
  authorizePhase10Validation,
  PHASE10_VALIDATION_CONFIRMATION,
} from "../src/lib/autopilot/validation";
import { pool } from "@workspace/db";

type WorkflowStage = "before-restart" | "after-restart" | "confirm-suspended";

function option(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--"))
    throw new Error(`Missing required --${name} option`);
  return value;
}

function positiveInteger(name: string): number {
  const value = Number(option(name));
  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`--${name} must be a positive integer`);
  return value;
}

async function main(): Promise<void> {
  const stage = process.argv[2] as WorkflowStage | undefined;
  if (
    !stage ||
    !["before-restart", "after-restart", "confirm-suspended"].includes(stage)
  ) {
    throw new Error(
      "Usage: pnpm validate:phase10 <before-restart|after-restart|confirm-suspended> --user-id N --mandate-id N --symbol BTCUSDT --strategy-id ID --run-id UUID --confirmation RUN_ONE_SIMULATED_DEMO_PHASE10_VALIDATION",
    );
  }
  if (!process.env.DATABASE_URL)
    throw new Error(
      "DATABASE_URL is required for the durable Phase 10 validation workflow",
    );
  const userId = positiveInteger("user-id");
  const mandateId = positiveInteger("mandate-id");
  const runId = option("run-id");
  const confirmation = option("confirmation");
  if (confirmation !== PHASE10_VALIDATION_CONFIRMATION) {
    throw new Error(
      "The explicit Phase 10 validation confirmation phrase is required",
    );
  }
  const authorization = authorizePhase10Validation({
    runId,
    operatorUserId: userId,
    confirmation,
    token: process.env.PHASE10_VALIDATION_TOKEN,
    requiresGlobalSuspension:
      stage === "confirm-suspended" ? "active" : "inactive",
  });
  const input = {
    authorization,
    userId,
    section: "crypto" as const,
    mandateId,
    symbol: option("symbol").trim().toUpperCase(),
    strategyId: option("strategy-id").trim(),
  };
  const result =
    stage === "before-restart"
      ? await runPhase10ValidationBeforeRestart(input)
      : stage === "after-restart"
        ? await runPhase10ValidationAfterRestart(input)
        : await confirmPhase10ValidationGlobalSuspension(input);
  console.log(JSON.stringify(result, null, 2));
}

main()
  .then(async () => {
    await pool.end();
  })
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    await pool.end().catch(() => undefined);
    process.exitCode = 1;
  });
