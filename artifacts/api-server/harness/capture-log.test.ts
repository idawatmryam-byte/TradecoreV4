/**
 * CAPTURE-LOG integration test — the historical asset's write path.
 *
 * Asserts the three things P2 actually promises:
 *
 *   1. A decision is captured WITH the inputs it was made on and the
 *      provenance to reproduce it (engine version, config version, market
 *      timestamp) — not just the conclusion.
 *   2. Snapshots deduplicate by content, so several strategies deciding on one
 *      symbol in one scan share a single feature_snapshots row.
 *   3. The log is append-only. Not "we don't write updates" — the database
 *      refuses them. This test only proves it for a non-owner role; run
 *      scripts/sql/capture-grants.sql in production and re-check.
 *
 * REQUIRES a database. Part of `pnpm test:integration`, not the pure chain.
 *
 * Run:  DATABASE_URL=... tsx harness/capture-log.test.ts   (exit 0 = pass)
 */
process.env.CREDENTIALS_ENCRYPTION_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.SESSION_SECRET ??= "capture-log-test-session-secret-123";

import { db, capturedDecisionsTable, featureSnapshotsTable, scanCountersTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { captureDecisions, recordScanCounters, scanCounterTotal, type CaptureSnapshot } from "../src/lib/capture/captureLog";
import { configVersionOf } from "../src/lib/capture/hashing";
import { ENGINE_VERSION } from "../src/lib/version";

const USER = 990043; // isolated test user — wiped before and after

let failures = 0;
function expect(name: string, cond: boolean, detail = "") {
  if (!cond) failures++;
  console.log(`${cond ? "✓" : "✗ FAIL"}  ${name}${cond ? "" : `  ${detail}`}`);
}

const DATA_TS = Date.UTC(2025, 5, 1, 12, 0, 0);
const rowFor = (confidence: number) => ({
  symbol: "BTCUSDT", confidence, rsi: 41.5, adx: 28, regime: "trend",
  atrPercent: 0.42, macroBullish: true, lastPrice: 60200,
}) as any;

async function cleanup() {
  // Runtime evidence is append-only. Test cleanup must use the same narrow
  // owner-defined erasure boundary as production instead of requiring DELETE
  // on capture tables. Content-addressed feature snapshots are intentionally
  // shared and remain as immutable, unowned inputs after decisions are purged.
  await db.execute(sql`SELECT capture.purge_user_data(${USER})`);
  await db.delete(scanCountersTable).where(eq(scanCountersTable.userId, USER));
}

async function main() {
  await cleanup();

  const snapshots = new Map<string, CaptureSnapshot>([
    ["BTCUSDT", { row: rowFor(72), dataTimestampMs: DATA_TS }],
  ]);
  const configVersion = configVersionOf({ trend_pullback: { maxLossUsdt: 25 } });

  // ── 1. Two strategies decide on the SAME symbol in the same scan ──────────
  console.log("\n— capture writes decisions with their inputs —");
  await captureDecisions({
    userId: USER, section: "crypto", provider: "test", venue: "spot", timeframe: "1m",
    configVersion, snapshots,
    decisions: [
      {
        outcome: "executed", symbol: "BTCUSDT", strategyId: "trend_pullback", side: "long",
        confidence: 72, stage: null, reason: "pullback held", payload: { plan: true },
        correlationId: "corr-capture-1", planFingerprint: "f".repeat(64),
      },
      {
        outcome: "rejected", symbol: "BTCUSDT", strategyId: "mean_reversion", side: "short",
        confidence: 51, stage: "reward-risk", payload: { report: true },
        reason: "net R:R below floor",
      },
    ],
  });

  const rows = await db.select().from(capturedDecisionsTable)
    .where(eq(capturedDecisionsTable.userId, USER)).orderBy(capturedDecisionsTable.id);
  expect("both decisions captured", rows.length === 2, `got ${rows.length}`);

  const executed = rows.find((r) => r.outcome === "executed");
  const rejected = rows.find((r) => r.outcome === "rejected");
  expect("executed decision kept its execution linkage", executed?.correlationId === "corr-capture-1");
  expect("executed decision kept its plan fingerprint", executed?.planFingerprint === "f".repeat(64));
  expect("rejection captured with its stage", rejected?.stage === "reward-risk");
  expect("rejection captured with its reasoning", rejected?.reason === "net R:R below floor");

  // Provenance — a decision with no context is a fact you cannot reproduce.
  expect("engine version stamped", executed?.engineVersion === ENGINE_VERSION, String(executed?.engineVersion));
  expect("config version stamped", executed?.configVersion === configVersion);
  expect("memory version defaults to no-influence", executed?.memoryVersion === "memory-0");
  expect(
    "data timestamp is MARKET time, not write time",
    executed!.dataTimestamp.getTime() === DATA_TS,
    `${executed!.dataTimestamp.toISOString()} vs ${new Date(DATA_TS).toISOString()}`,
  );
  expect("write time differs from market time", executed!.createdAt.getTime() !== DATA_TS);

  // ── 2. Snapshot dedupe ────────────────────────────────────────────────────
  console.log("\n— identical inputs share one snapshot row —");
  expect("both decisions point at the same snapshot", executed?.featureSnapshotId === rejected?.featureSnapshotId);
  const snaps = await db.select().from(featureSnapshotsTable)
    .where(eq(featureSnapshotsTable.id, executed!.featureSnapshotId));
  expect("exactly one snapshot stored for the pair", snaps.length === 1);
  expect("snapshot carries the full feature row", (snaps[0]!.features as any).confidence === 72);
  expect("snapshot records the provider/venue", snaps[0]!.provider === "test" && snaps[0]!.venue === "spot");

  // A second scan with genuinely different features must NOT reuse it.
  await captureDecisions({
    userId: USER, section: "crypto", provider: "test", venue: "spot", timeframe: "1m",
    configVersion,
    snapshots: new Map([["BTCUSDT", { row: rowFor(88), dataTimestampMs: DATA_TS + 60_000 }]]),
    decisions: [{
      outcome: "approved_not_taken", symbol: "BTCUSDT", strategyId: "trend_pullback",
      side: "long", confidence: 88, stage: "Portfolio Risk", reason: "cap reached", payload: null,
    }],
  });
  const allRows = await db.select().from(capturedDecisionsTable).where(eq(capturedDecisionsTable.userId, USER));
  const distinctSnaps = new Set(allRows.map((r) => r.featureSnapshotId));
  expect("a different market state gets its own snapshot", distinctSnaps.size === 2, `${distinctSnaps.size}`);

  // ── 3. Signal-only: no-decision scans are counted, not snapshotted ────────
  console.log("\n— scans with no decision are counted, not captured —");
  const before = await scanCounterTotal(USER, "crypto");
  // Snapshots are platform-wide (deduped by content hash, no user column), so
  // on any database where a real engine has scanned ETHUSDT the absolute count
  // is nonzero. Assert the contract as a delta: counted scans must not add one.
  const ethSnapshotsBefore = (
    await db.select().from(featureSnapshotsTable).where(eq(featureSnapshotsTable.symbol, "ETHUSDT"))
  ).length;
  const stages = new Map([["ETHUSDT", "no_signal"], ["SOLUSDT", "Risk Checks"]]);
  await recordScanCounters(USER, "crypto", new Date(DATA_TS), stages);
  await recordScanCounters(USER, "crypto", new Date(DATA_TS + 60_000), stages); // same hour
  const after = await scanCounterTotal(USER, "crypto");
  expect("four scan observations counted", after - before === 4, `${after - before}`);
  const counters = await db.select().from(scanCountersTable).where(eq(scanCountersTable.userId, USER));
  expect("bucketed into 2 rows, not 4 (hourly aggregate)", counters.length === 2, `${counters.length}`);
  expect("each bucket counted twice", counters.every((c) => c.count === 2));
  expect(
    "no snapshot written for a counted scan",
    (await db.select().from(featureSnapshotsTable).where(eq(featureSnapshotsTable.symbol, "ETHUSDT"))).length === ethSnapshotsBefore,
  );

  // ── 4. Append-only ────────────────────────────────────────────────────────
  console.log("\n— the capture log does not mutate —");
  const idsBefore = allRows.map((r) => r.id).sort();
  await captureDecisions({
    userId: USER, section: "crypto", provider: "test", venue: "spot", timeframe: "1m",
    configVersion, snapshots,
    decisions: [{
      outcome: "rejected", symbol: "BTCUSDT", strategyId: "mean_reversion", side: "short",
      confidence: 51, stage: "reward-risk", reason: "net R:R below floor", payload: { report: true },
    }],
  });
  const afterRepeat = await db.select().from(capturedDecisionsTable)
    .where(eq(capturedDecisionsTable.userId, USER)).orderBy(capturedDecisionsTable.id);
  expect(
    "an identical repeat decision APPENDS (unlike the deduping feed)",
    afterRepeat.length === idsBefore.length + 1,
    `${afterRepeat.length} vs ${idsBefore.length}`,
  );
  expect(
    "no previously-written row was touched",
    idsBefore.every((id) => afterRepeat.some((r) => r.id === id)),
  );

  // Whether the DATABASE enforces it depends on the connecting role. The
  // harness connects as owner, which bypasses grants — say so rather than
  // claiming a guarantee this run did not test.
  const ownerCheck = await db.execute(sql`
    SELECT pg_catalog.pg_get_userbyid(nspowner) = current_user AS is_owner
    FROM pg_namespace WHERE nspname = 'capture'
  `);
  const isOwner = Boolean((ownerCheck.rows?.[0] as { is_owner?: boolean } | undefined)?.is_owner);
  if (isOwner) {
    console.log("   (this role OWNS the capture schema, so grants are bypassed —");
    console.log("    run scripts/sql/capture-grants.sql with a non-owner app role in production)");
  } else {
    let refused = false;
    try {
      await db.update(capturedDecisionsTable).set({ reason: "tampered" })
        .where(eq(capturedDecisionsTable.userId, USER));
    } catch { refused = true; }
    expect("the database REFUSES an update to a capture row", refused);
  }

  await cleanup();
  console.log(failures === 0 ? "\nAll capture-log checks passed." : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
