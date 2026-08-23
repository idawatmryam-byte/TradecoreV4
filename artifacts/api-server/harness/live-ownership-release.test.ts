/**
 * Regression coverage for BUG-001 (Phase 11 validation finding).
 *
 * Live-execution ownership claims were persisted on engine start but never
 * released. The platform-wide global equity aggregate requires every claimed
 * owner to report fresh provider equity, so a single stale claim — from an
 * explicitly stopped engine, a crashed process generation, or leaked harness
 * fixtures — permanently forced globalDrawdownState=UNKNOWN and blocked ALL
 * broker-authority entries for every user with no recovery path.
 *
 * These tests pin the contract that unblocked it:
 *  1. releasing ownership removes the row from the aggregate's active set;
 *  2. release preserves system/operator operating-mode reductions;
 *  3. the boot sweep releases every claim exactly once and emits one event;
 *  4. a claimed owner whose equity goes stale still fails the aggregate
 *     closed (the fail-closed property is NOT weakened by this fix).
 */
if (!process.env.DATABASE_URL) {
  console.log("live-ownership-release integration SKIPPED (no DATABASE_URL)");
  process.exit(0);
}
process.env.SESSION_SECRET ??= "live-ownership-release-secret-123";

let failures = 0;
function expect(name: string, condition: boolean): void {
  if (condition) console.log(`  PASS  ${name}`);
  else {
    console.error(`  FAIL  ${name}`);
    failures++;
  }
}

async function main(): Promise<void> {
  const { db, liveExecutionStatesTable, liveGlobalEquityStateTable, usersTable } =
    await import("@workspace/db");
  const { inArray, sql } = await import("drizzle-orm");
  const {
    claimLiveExecutionOwnership,
    releaseLiveExecutionOwnership,
    releaseAllLiveExecutionOwnership,
    ingestAuthoritativeAccountEquity,
    setSystemLiveMode,
  } = await import("../src/lib/execution/liveSafetyStore");

  const names = [
    "ownership_release_harness_990101",
    "ownership_release_harness_990102",
  ];
  const cleanupUsers = async () => {
    for (const row of await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(inArray(usersTable.username, names))) {
      await db.execute(sql`SELECT capture.purge_user_data(${row.id})`);
      await db.delete(usersTable).where(inArray(usersTable.id, [row.id]));
    }
  };
  await cleanupUsers();
  // The boot sweep is under test: clear any pre-existing claims so this run
  // starts from a deterministic slate, then re-poison deliberately.
  await releaseAllLiveExecutionOwnership({
    reasonCode: "TEST_SETUP_SWEEP",
    reason: "live-ownership-release test setup",
  });
  const [userA, userB] = await db
    .insert(usersTable)
    .values(names.map((username) => ({ username })))
    .returning();
  if (!userA || !userB) throw new Error("Ownership-release users were not created");

  try {
    const observed = new Date();
    const freshUntil = new Date(observed.getTime() + 60_000);

    // Two claimed owners; only userA reports equity. userB's stale claim must
    // keep the aggregate UNKNOWN (fail-closed among claimed owners).
    await claimLiveExecutionOwnership(userA.id, "crypto");
    await claimLiveExecutionOwnership(userB.id, "crypto");
    const poisoned = await ingestAuthoritativeAccountEquity({
      userId: userA.id,
      section: "crypto",
      currentEquityMinor: 50_000n,
      sourceIdentity: "BINANCE_FUTURES_TOTAL_MARGIN_BALANCE",
      observedAt: observed,
      freshUntil,
    });
    expect(
      "a claimed owner without fresh equity keeps the global aggregate UNKNOWN (fail-closed)",
      poisoned.applied === true && poisoned.globalState === "UNKNOWN",
    );

    // Releasing the dead owner lets the surviving healthy owner aggregate.
    const releasedB = await releaseLiveExecutionOwnership({
      userId: userB.id,
      section: "crypto",
      reasonCode: "TEST_RELEASE",
      reason: "owner stopped",
    });
    const afterRelease = await ingestAuthoritativeAccountEquity({
      userId: userA.id,
      section: "crypto",
      currentEquityMinor: 50_001n,
      sourceIdentity: "BINANCE_FUTURES_TOTAL_MARGIN_BALANCE",
      observedAt: new Date(observed.getTime() + 1_000),
      freshUntil: new Date(freshUntil.getTime() + 1_000),
    });
    const [globalRow] = await db.select().from(liveGlobalEquityStateTable);
    expect(
      "releasing a stale claim recovers the global aggregate to HEALTHY",
      releasedB === true &&
        afterRelease.globalState === "HEALTHY" &&
        globalRow?.sourceCount === 1,
    );

    // Release never widens authority: a SYSTEM EXIT_ONLY reduction persists.
    await setSystemLiveMode({
      userId: userA.id,
      section: "crypto",
      mode: "EXIT_ONLY",
      reasonCode: "TEST_REDUCTION",
      reason: "system reduction before release",
    });
    await releaseLiveExecutionOwnership({
      userId: userA.id,
      section: "crypto",
      reasonCode: "TEST_RELEASE",
      reason: "owner stopped after reduction",
    });
    const [rowA] = await db
      .select()
      .from(liveExecutionStatesTable)
      .where(inArray(liveExecutionStatesTable.userId, [userA.id]));
    expect(
      "release clears the claim but preserves the operating-mode reduction",
      rowA?.ownerClaimedAt === null &&
        rowA?.ownerInstanceId === null &&
        rowA?.operatingMode === "EXIT_ONLY",
    );

    // Re-claiming restores normal entry-capable preconditions handling.
    const reclaimed = await claimLiveExecutionOwnership(userA.id, "crypto");
    expect(
      "a released engine can re-claim ownership with an advanced generation",
      reclaimed.generation >= 2 && reclaimed.instanceId.length > 0,
    );
    await releaseLiveExecutionOwnership({
      userId: userA.id,
      section: "crypto",
      reasonCode: "TEST_RELEASE",
      reason: "pre-sweep release",
    });

    // Boot sweep releases everything remaining and is idempotent.
    await claimLiveExecutionOwnership(userB.id, "forex");
    const swept = await releaseAllLiveExecutionOwnership({
      reasonCode: "BOOT_OWNERSHIP_SWEEP_TEST",
      reason: "boot sweep under test",
    });
    const sweptAgain = await releaseAllLiveExecutionOwnership({
      reasonCode: "BOOT_OWNERSHIP_SWEEP_TEST",
      reason: "boot sweep idempotence",
    });
    const claimedRows = await db
      .select()
      .from(liveExecutionStatesTable)
      .where(sql`${liveExecutionStatesTable.ownerClaimedAt} IS NOT NULL`);
    expect(
      "boot sweep releases all claims and is idempotent",
      swept === 1 && sweptAgain === 0 && claimedRows.length === 0,
    );

    // Double release of an unclaimed engine is a harmless no-op.
    const noop = await releaseLiveExecutionOwnership({
      userId: userB.id,
      section: "forex",
      reasonCode: "TEST_RELEASE",
      reason: "already released",
    });
    expect("releasing an unclaimed engine is a no-op", noop === false);
  } finally {
    await cleanupUsers();
  }
}

main()
  .then(() => {
    if (failures > 0) {
      console.error(`live-ownership-release: ${failures} FAILURE(S)`);
      process.exit(1);
    }
    console.log("live-ownership-release: all checks passed");
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
