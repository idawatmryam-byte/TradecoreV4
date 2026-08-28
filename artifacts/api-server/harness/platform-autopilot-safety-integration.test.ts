/** PostgreSQL-backed platform AutoPilot suspension and dual-operator resume. */
if (!process.env.DATABASE_URL) {
  console.log("platform-autopilot-safety integration SKIPPED (no DATABASE_URL)");
  process.exit(0);
}

const previousHardStop = process.env.AUTOPILOT_GLOBAL_SUSPENDED;
delete process.env.AUTOPILOT_GLOBAL_SUSPENDED;

const {
  approvePlatformAutopilotResume,
  getPlatformAutopilotSafetyState,
  requestPlatformAutopilotResume,
  suspendPlatformAutopilot,
} = await import("../src/lib/platformAutopilotSafety");

const REQUESTER = 990201;
const APPROVER_A = 990202;
const APPROVER_B = 990203;
let failures = 0;

function expect(name: string, condition: boolean, detail = "") {
  if (!condition) failures++;
  console.log(
    `${condition ? "✓" : "✗ FAIL"}  ${name}${condition ? "" : `  ${detail}`}`,
  );
}

async function main() {
  await suspendPlatformAutopilot({
    actorUserId: REQUESTER,
    reason: "Integration harness establishes the fail-closed starting state",
    auditRequestId: `integration-suspend-start-${crypto.randomUUID()}`,
  });
  let state = await getPlatformAutopilotSafetyState();
  expect("a qualified operator may immediately reduce authority", state.effectiveSuspended);

  const resumeRequestId = crypto.randomUUID();
  state = await requestPlatformAutopilotResume({
    actorUserId: REQUESTER,
    reason: "Integration harness requests a bounded Demo AutoPilot resume",
    clientRequestId: resumeRequestId,
    auditRequestId: `integration-request-${crypto.randomUUID()}`,
  });
  expect(
    "resume remains suspended while awaiting a second operator",
    state.effectiveSuspended && state.pendingResume?.requestId === resumeRequestId,
  );

  let sameOperatorRefused = false;
  try {
    await approvePlatformAutopilotResume({
      actorUserId: REQUESTER,
      resumeRequestId,
      reason: "The requesting operator must not self-approve this resume",
      auditRequestId: `integration-self-approve-${crypto.randomUUID()}`,
    });
  } catch {
    sameOperatorRefused = true;
  }
  expect("the requesting operator cannot approve their own resume", sameOperatorRefused);

  const approvals = await Promise.allSettled(
    [APPROVER_A, APPROVER_B].map((actorUserId) =>
      approvePlatformAutopilotResume({
        actorUserId,
        resumeRequestId,
        reason: "A distinct integration operator approved the reviewed Demo resume",
        auditRequestId: `integration-approve-${actorUserId}-${crypto.randomUUID()}`,
      }),
    ),
  );
  expect(
    "concurrent approvals produce exactly one authority-expanding transition",
    approvals.filter((result) => result.status === "fulfilled").length === 1,
  );
  state = await getPlatformAutopilotSafetyState();
  expect(
    "dual approval clears only the persisted platform suspension",
    !state.effectiveSuspended && state.pendingResume === null,
  );

  process.env.AUTOPILOT_GLOBAL_SUSPENDED = "true";
  state = await getPlatformAutopilotSafetyState();
  expect(
    "the deployment emergency hard stop overrides an approved persisted resume",
    state.effectiveSuspended && state.source === "DEPLOYMENT_HARD_STOP",
  );
}

try {
  await main();
} finally {
  delete process.env.AUTOPILOT_GLOBAL_SUSPENDED;
  await suspendPlatformAutopilot({
    actorUserId: REQUESTER,
    reason: "Integration harness restores the platform fail-closed state",
    auditRequestId: `integration-suspend-end-${crypto.randomUUID()}`,
  });
  if (previousHardStop === undefined) delete process.env.AUTOPILOT_GLOBAL_SUSPENDED;
  else process.env.AUTOPILOT_GLOBAL_SUSPENDED = previousHardStop;
}

if (failures > 0) process.exit(1);
console.log("platform-autopilot-safety integration: all checks passed");
