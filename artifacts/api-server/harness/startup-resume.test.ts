import {
  coordinateEngineResume,
  engineResumeConfiguration,
  type EngineResumeOutcome,
  type EngineResumeTarget,
} from "../src/lib/engineResumeCoordinator";
import {
  beginEngineResume,
  getEngineResumeHealth,
  recordEngineResume,
} from "../src/lib/startupHealth";
import { readinessState } from "../src/lib/readiness";

let failures = 0;
function expect(name: string, condition: boolean, detail = "") {
  if (!condition) failures++;
  console.log(
    `${condition ? "✓" : "✗ FAIL"}  ${name}${condition ? "" : `  ${detail}`}`,
  );
}

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

beginEngineResume(0);
expect(
  "zero engines complete healthy",
  getEngineResumeHealth().status === "healthy",
);

const configured = engineResumeConfiguration({
  ENGINE_RESUME_CONCURRENCY: "99",
  ENGINE_RESUME_TIMEOUT_SECONDS: "1",
} as NodeJS.ProcessEnv);
expect(
  "resume concurrency is conservatively capped",
  configured.concurrency === 4,
  JSON.stringify(configured),
);
expect(
  "resume timeout cannot be configured below the safe minimum",
  configured.timeoutMs === 10_000,
  JSON.stringify(configured),
);

let active = 0;
let maxActive = 0;
const starts: string[] = [];
const outcomes: EngineResumeOutcome[] = [];
const makeTarget = (
  key: string,
  ms: number,
  healthy = true,
  rejects = false,
): EngineResumeTarget => ({
  key,
  async resume() {
    starts.push(key);
    active++;
    maxActive = Math.max(maxActive, active);
    try {
      await delay(ms);
      if (rejects) throw new Error(`failed-${key}`);
      return { healthy, detail: healthy ? "healthy" : "exit-only" };
    } finally {
      active--;
    }
  },
  failClosedOnTimeout() {},
});

await coordinateEngineResume(
  [
    makeTarget("3:crypto", 8),
    makeTarget("1:crypto", 8),
    makeTarget("2:crypto", 8),
  ],
  {
    concurrency: 2,
    timeoutMs: 100,
    onOutcome: (outcome) => outcomes.push(outcome),
  },
);
expect(
  "multiple engines use bounded concurrency",
  maxActive === 2,
  `maxActive=${maxActive}`,
);
expect(
  "engine scheduling begins in deterministic key order",
  starts.slice(0, 2).join(",") === "1:crypto,2:crypto",
  starts.join(","),
);
expect(
  "all bounded resumes are accounted",
  outcomes.length === 3 && outcomes.every((outcome) => outcome.success),
);

let timeoutFailClosed = 0;
active = 0;
maxActive = 0;
const timeoutOutcomes: EngineResumeOutcome[] = [];
const slow = makeTarget("1:slow", 35);
slow.failClosedOnTimeout = () => {
  timeoutFailClosed++;
};
await coordinateEngineResume([slow, makeTarget("2:after-slow", 1)], {
  concurrency: 1,
  timeoutMs: 10,
  onOutcome: (outcome) => timeoutOutcomes.push(outcome),
});
expect(
  "slow engine produces one timeout failure",
  timeoutOutcomes.length === 2 && timeoutOutcomes[0]?.timedOut === true,
);
expect(
  "timed-out engine is failed closed exactly once",
  timeoutFailClosed === 1,
  String(timeoutFailClosed),
);
expect(
  "timed-out provider work retains its worker slot",
  maxActive === 1,
  `maxActive=${maxActive}`,
);

const rejected: EngineResumeOutcome[] = [];
await coordinateEngineResume([makeTarget("1:failure", 1, false, true)], {
  concurrency: 1,
  timeoutMs: 100,
  onOutcome: (outcome) => rejected.push(outcome),
});
expect(
  "one rejected engine is not lost",
  rejected.length === 1 && !rejected[0]?.success && !rejected[0]?.timedOut,
);

beginEngineResume(3);
recordEngineResume(true);
recordEngineResume(false);
expect(
  "readiness stays pending while one expected result is outstanding",
  getEngineResumeHealth().status === "pending",
);
recordEngineResume(true);
const degraded = getEngineResumeHealth();
expect(
  "one failed engine produces deterministic degraded accounting",
  degraded.status === "degraded" &&
    degraded.expected === 3 &&
    degraded.resumed === 2 &&
    degraded.failed === 1,
  JSON.stringify(degraded),
);
expect(
  "pending readiness is distinguishable from failed readiness",
  readinessState(true, { ...degraded, status: "pending" }).reason ===
    "engine_resume_pending" &&
    readinessState(true, degraded).reason === "engine_resume_failed",
);
expect(
  "database failure takes precedence in readiness",
  readinessState(false, degraded).reason === "database_unhealthy",
);

console.log(
  failures === 0
    ? "\nstartup-resume: all checks passed"
    : `\nstartup-resume: ${failures} FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
