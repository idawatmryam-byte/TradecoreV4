import assert from "node:assert/strict";
process.env.DATABASE_URL = "postgres://unused:unused@127.0.0.1:1/unused";
const { db } = await import("@workspace/db");
const { getOrCreateEngine, sweepIdleDemoEngines, evictUserEngines } =
  await import("../src/lib/engineRegistry");

const user = 991901;
const engine = getOrCreateEngine(user, "crypto");
// Replace only IO and timers; exercise the actual pause and sweeper policies.
const internal = engine as any;
const mutableDb = db as any;
const originalSelect = mutableDb.select;
let rows: unknown[][] = [];
let readError = false;
let startScanDuringRead = false;
let mode = "copilot";
let pauses = 0;
internal.loadConfig = async () => ({ mode, engineDesiredRunning: true });
internal.quiesceAndTeardown = async () => {
  pauses++;
  internal.state.running = false;
};
mutableDb.select = () => {
  if (readError) throw new Error("test database unavailable");
  return {
    from: () => ({
      where: () => ({
        limit: async () => {
          if (startScanDuringRead) internal.scanning = true;
          return rows.shift() ?? [];
        },
      }),
    }),
  };
};
function running(target = "demo") {
  internal.executionTarget = target;
  internal.state.running = true;
  internal.state.openPositions = 0;
  internal.scanning = false;
}

try {
  running();
  rows = [[{ id: 1 }]];
  assert.equal(
    await engine.pauseForIdle(),
    false,
    "durable open exposure must keep scanning despite a stale zero count",
  );
  assert.equal(pauses, 0);

  mode = "autopilot";
  rows = [[], [{ state: "AUTOPILOT_ENABLED" }]];
  assert.equal(
    await engine.pauseForIdle(),
    false,
    "enabled AutoPilot must keep scanning without dashboard activity",
  );

  running("live");
  assert.equal(
    await engine.pauseForIdle(),
    false,
    "idle pause must never stop a live engine, even when called directly",
  );

  running();
  readError = true;
  assert.equal(
    await engine.pauseForIdle(),
    false,
    "unavailable exposure must preserve monitoring",
  );
  readError = false;
  mode = "copilot";
  startScanDuringRead = true;
  assert.equal(
    await engine.pauseForIdle(),
    false,
    "a scan starting during the check must finish before an idle pause",
  );
  startScanDuringRead = false;

  running();
  rows = [[{ id: 1 }]];
  assert.deepEqual(
    await sweepIdleDemoEngines(Date.now() + 3_600_000),
    [],
    "sweeper must not report a refused pause as stopped",
  );
  assert.equal(engine.isRunning(), true);

  rows = [[]];
  assert.deepEqual(await sweepIdleDemoEngines(Date.now() + 3_600_000), [
    `${user}:crypto`,
  ]);
  assert.equal(pauses, 1, "a flat idle Co-Pilot can still release resources");
  assert.equal(engine.isRunning(), false);
  console.log(
    "demo-idle-safety: open exposure, enabled AutoPilot, Live isolation, database errors, scan races, and sweeper reporting passed",
  );
} finally {
  mutableDb.select = originalSelect;
  evictUserEngines(user);
}
