process.env.SESSION_SECRET ??= "phase11-graceful-drain-test-secret";
// BotEngine's module graph includes the database boundary, although this
// harness exercises only in-memory drain state. Keep the pure-test job
// database-free while satisfying the import-time configuration guard.
process.env.DATABASE_URL ??= "postgres://unused:unused@127.0.0.1:5432/unused";

const { BotEngine } = await import("../src/lib/botEngine");

let failures = 0;
function expect(name: string, ok: boolean): void {
  if (ok) console.log(`  PASS  ${name}`);
  else {
    console.error(`  FAIL  ${name}`);
    failures++;
  }
}

async function main(): Promise<void> {
  const engine = new BotEngine(91_001, "crypto");
  const internal = engine as unknown as {
    executionTarget: "demo" | "live";
    scanning: boolean;
    notifyProviderWorkIdle(): void;
    state: {
      running: boolean;
      newEntriesAllowed: boolean;
      entryBlockReason: string | null;
    };
  };
  internal.executionTarget = "demo";
  internal.state.running = true;
  internal.state.newEntriesAllowed = true;
  internal.state.entryBlockReason = null;
  internal.scanning = true;

  let settled = false;
  const draining = engine.drainForShutdown("test deployment drain").then(() => {
    settled = true;
  });

  await Promise.resolve();
  expect(
    "drain closes new-entry authority before waiting for provider work",
    !engine.getState().newEntriesAllowed &&
      engine.getState().entryBlockReason === "Engine is stopped",
  );
  expect("drain waits for an active scan", !settled);

  internal.scanning = false;
  internal.notifyProviderWorkIdle();
  await draining;

  expect("drain completes after provider work releases", settled);
  expect("drained engine is stopped", !engine.isRunning());

  console.log(
    failures === 0
      ? "\ngraceful-drain: all checks passed"
      : `\ngraceful-drain: ${failures} FAILED`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
