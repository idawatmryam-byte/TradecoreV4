process.env.SESSION_SECRET ??= "phase11-graceful-drain-test-secret";

import { BotEngine } from "../src/lib/botEngine";

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
