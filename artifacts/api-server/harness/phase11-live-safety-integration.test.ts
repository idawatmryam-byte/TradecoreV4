/** PostgreSQL-only Phase 11 drawdown and reconciliation action verification. */
if (!process.env.DATABASE_URL) {
  console.log("phase11-live-safety integration SKIPPED (no DATABASE_URL)");
  process.exit(0);
}
process.env.SESSION_SECRET ??= "phase11-live-safety-integration-secret-123";
process.env.PORT ??= "8080";

import { and, eq, inArray, sql } from "drizzle-orm";

let failures = 0;
function expect(name: string, condition: boolean): void {
  if (condition) console.log(`  PASS  ${name}`);
  else {
    console.error(`  FAIL  ${name}`);
    failures++;
  }
}

async function main(): Promise<void> {
  const {
    db,
    executionIntentsTable,
    liveExecutionStatesTable,
    liveGlobalEquityStateTable,
    usersTable,
  } = await import("@workspace/db");
  const {
    applyOperatorReconciliationAction,
    claimLiveExecutionOwnership,
    evaluatePersistedLiveSafety,
    ingestAuthoritativeAccountEquity,
    markAuthoritativeAccountEquityUnknown,
    ReconciliationActionError,
    setOperatorLiveMode,
  } = await import("../src/lib/execution/liveSafetyStore");
  const { reconcileNonTerminalIntents } =
    await import("../src/lib/execution/intentReconciliation");

  const names = [
    "phase11_live_safety_harness_990091",
    "phase11_live_safety_harness_990092",
  ];
  await db.delete(usersTable).where(inArray(usersTable.username, names));
  const [userA, userB] = await db
    .insert(usersTable)
    .values(names.map((username) => ({ username })))
    .returning();
  if (!userA || !userB) throw new Error("Phase 11 users were not created");
  const cleanup = async () => {
    for (const user of [userA, userB]) {
      await db.execute(sql`SELECT capture.purge_user_data(${user.id})`);
      await db
        .delete(executionIntentsTable)
        .where(eq(executionIntentsTable.userId, user.id));
      await db.delete(usersTable).where(eq(usersTable.id, user.id));
    }
  };

  try {
    const observed = new Date("2026-08-21T12:00:00.000Z");
    const freshUntil = new Date("2026-08-21T12:05:00.000Z");
    await db.insert(liveExecutionStatesTable).values([
      {
        userId: userA.id,
        section: "crypto",
        ownerInstanceId: "phase11-owner-a",
        ownerClaimedAt: observed,
        ownershipGeneration: 3,
      },
      {
        userId: userB.id,
        section: "crypto",
        ownerInstanceId: "phase11-owner-b",
        ownerClaimedAt: observed,
        ownershipGeneration: 5,
      },
    ]);

    const initial = await db
      .select()
      .from(liveExecutionStatesTable)
      .where(eq(liveExecutionStatesTable.userId, userA.id));
    expect(
      "new account equity authority begins UNKNOWN, never zero",
      initial[0]?.accountDrawdownState === "UNKNOWN" &&
        initial[0]?.currentEquityMinor === null,
    );

    const first = await ingestAuthoritativeAccountEquity({
      userId: userA.id,
      section: "crypto",
      currentEquityMinor: 10_000n,
      sourceIdentity: "BINANCE_FUTURES_TOTAL_MARGIN_BALANCE",
      observedAt: observed,
      freshUntil,
    });
    expect(
      "fresh authoritative account equity persists with a monotonic peak",
      first.applied && first.accountState === "HEALTHY",
    );

    const under = await ingestAuthoritativeAccountEquity({
      userId: userA.id,
      section: "crypto",
      currentEquityMinor: 8_001n,
      sourceIdentity: "BINANCE_FUTURES_TOTAL_MARGIN_BALANCE",
      observedAt: new Date(observed.getTime() + 1_000),
      freshUntil: new Date(freshUntil.getTime() + 1_000),
    });
    expect(
      "drawdown just under the exact limit stays healthy",
      under.accountState === "HEALTHY",
    );
    const boundary = await ingestAuthoritativeAccountEquity({
      userId: userA.id,
      section: "crypto",
      currentEquityMinor: 8_000n,
      sourceIdentity: "BINANCE_FUTURES_TOTAL_MARGIN_BALANCE",
      observedAt: new Date(observed.getTime() + 2_000),
      freshUntil: new Date(freshUntil.getTime() + 2_000),
    });
    expect(
      "drawdown exactly at the configured limit breaches",
      boundary.accountState === "BREACHED",
    );

    const staleReplay = await ingestAuthoritativeAccountEquity({
      userId: userA.id,
      section: "crypto",
      currentEquityMinor: 99_999n,
      sourceIdentity: "BINANCE_FUTURES_TOTAL_MARGIN_BALANCE",
      observedAt,
      freshUntil,
    });
    const [persisted] = await db
      .select()
      .from(liveExecutionStatesTable)
      .where(eq(liveExecutionStatesTable.userId, userA.id));
    expect(
      "out-of-order provider replay cannot rewrite equity or peak",
      !staleReplay.applied &&
        persisted?.currentEquityMinor === "8000" &&
        persisted?.peakEquityMinor === "10000",
    );

    let invalidRejected = false;
    try {
      await ingestAuthoritativeAccountEquity({
        userId: userA.id,
        section: "crypto",
        currentEquityMinor: -1n,
        sourceIdentity: "BINANCE_FUTURES_TOTAL_MARGIN_BALANCE",
        observedAt: new Date(observed.getTime() + 3_000),
        freshUntil: new Date(freshUntil.getTime() + 3_000),
      });
    } catch {
      invalidRejected = true;
    }
    expect("negative authoritative equity is rejected", invalidRejected);
    let extremeRejected = false;
    try {
      await ingestAuthoritativeAccountEquity({
        userId: userA.id,
        section: "crypto",
        currentEquityMinor: 10n ** 30n,
        sourceIdentity: "BINANCE_FUTURES_TOTAL_MARGIN_BALANCE",
        observedAt: new Date(observed.getTime() + 3_000),
        freshUntil: new Date(freshUntil.getTime() + 3_000),
      });
    } catch {
      extremeRejected = true;
    }
    expect(
      "equity beyond persisted exact precision is rejected",
      extremeRejected,
    );

    await ingestAuthoritativeAccountEquity({
      userId: userB.id,
      section: "crypto",
      currentEquityMinor: 20_000n,
      sourceIdentity: "OANDA_NAV_USD",
      observedAt: new Date(observed.getTime() + 2_000),
      freshUntil: new Date(freshUntil.getTime() + 2_000),
    });
    const [global] = await db
      .select()
      .from(liveGlobalEquityStateTable)
      .where(eq(liveGlobalEquityStateTable.id, "platform"));
    expect(
      "global equity aggregates all active fresh authoritative account sources",
      global?.sourceCount === 2 && global.currentEquityMinor === "28000",
    );

    await markAuthoritativeAccountEquityUnknown({
      userId: userA.id,
      section: "crypto",
      reasonCode: "TEST_PROVIDER_UNAVAILABLE",
      reason: "Provider unavailable in deterministic integration fixture",
    });
    const accountRows = await db
      .select()
      .from(liveExecutionStatesTable)
      .where(
        and(
          eq(liveExecutionStatesTable.section, "crypto"),
          inArray(liveExecutionStatesTable.userId, [userA.id, userB.id]),
        ),
      );
    expect(
      "provider outage makes account and global authority UNKNOWN for every tenant projection",
      accountRows.find((row) => row.userId === userA.id)
        ?.accountDrawdownState === "UNKNOWN" &&
        accountRows.every((row) => row.globalDrawdownState === "UNKNOWN"),
    );

    const [intent] = await db
      .insert(executionIntentsTable)
      .values({
        userId: userA.id,
        section: "crypto",
        correlationId: "phase11-reconciliation-correlation",
        clientOrderId: "phase11-reconciliation-entry",
        planFingerprint: "f".repeat(64),
        symbol: "BTCUSDT",
        side: "buy",
        marketType: "futures",
        plannedEntryPrice: "60000",
        plannedStopLoss: "59000",
        plannedTakeProfit: "62000",
        plannedQuantity: "0.1",
        state: "ESCALATED",
        resolutionCode: "RECOVERY_EVIDENCE_INCOMPLETE",
      })
      .returning();
    if (!intent) throw new Error("Phase 11 intent was not created");

    const action = (overrides: Record<string, unknown> = {}) =>
      applyOperatorReconciliationAction({
        userId: userA.id,
        section: "crypto",
        intentId: intent.id,
        ownershipGeneration: 3,
        action: "RETRY_RECOVERY",
        idempotencyKey: "phase11-action-key-0001",
        reason: "Retry using refreshed authoritative broker evidence",
        ...overrides,
      } as any);
    let invalidEvidence = "";
    try {
      await action();
    } catch (error) {
      invalidEvidence =
        error instanceof ReconciliationActionError ? error.code : "unexpected";
    }
    expect(
      "operator retry refuses missing authoritative fill evidence",
      invalidEvidence === "AUTHORITATIVE_FILL_EVIDENCE_REQUIRED",
    );

    await db
      .update(executionIntentsTable)
      .set({ filledQuantity: "0.1", averageFillPrice: "60000" })
      .where(eq(executionIntentsTable.id, intent.id));
    let staleOwner = "";
    try {
      await action({ ownershipGeneration: 2 });
    } catch (error) {
      staleOwner =
        error instanceof ReconciliationActionError ? error.code : "unexpected";
    }
    expect(
      "stale operator ownership is fenced",
      staleOwner === "STALE_EXECUTION_OWNER",
    );

    let crossUser = "";
    try {
      await action({ userId: userB.id, ownershipGeneration: 5 });
    } catch (error) {
      crossUser =
        error instanceof ReconciliationActionError ? error.code : "unexpected";
    }
    expect(
      "one user cannot act on another user's intent",
      crossUser === "INTENT_NOT_FOUND",
    );

    const applied = await action();
    const duplicate = await action();
    expect(
      "operator recovery action is auditable and idempotent",
      applied.applied && !duplicate.applied,
    );

    await db
      .update(executionIntentsTable)
      .set({ state: "FAILED" })
      .where(eq(executionIntentsTable.id, intent.id));
    const [restartIntent, partialIntent] = await db
      .insert(executionIntentsTable)
      .values([
        {
          userId: userA.id,
          section: "crypto",
          correlationId: "phase11-restart-recovery",
          clientOrderId: "phase11-entry-after-timeout",
          planFingerprint: "1".repeat(64),
          symbol: "BTCUSDT",
          side: "buy",
          marketType: "futures",
          plannedEntryPrice: "60000",
          plannedStopLoss: "59000",
          plannedTakeProfit: "62000",
          plannedQuantity: "0.2",
          state: "RECONCILIATION_REQUIRED",
          recoveryClientOrderId: "tc-rec-restart-stable",
          recoveryState: "SUBMITTED",
        },
        {
          userId: userA.id,
          section: "crypto",
          correlationId: "phase11-partial-recovery",
          clientOrderId: "phase11-entry-partial",
          planFingerprint: "2".repeat(64),
          symbol: "ETHUSDT",
          side: "buy",
          marketType: "futures",
          plannedEntryPrice: "4000",
          plannedStopLoss: "3900",
          plannedTakeProfit: "4200",
          plannedQuantity: "1",
          state: "SUBMITTED",
        },
      ])
      .returning();
    if (!restartIntent || !partialIntent) {
      throw new Error("Recovery integration intents were not created");
    }
    let restartRecoveryCalls = 0;
    let partialRecoveryCalls = 0;
    const reconcile = () =>
      reconcileNonTerminalIntents({
        userId: userA.id,
        section: "crypto",
        resolveOrder: async (candidate) =>
          candidate.id === partialIntent.id
            ? {
                status: "OPEN",
                brokerOrderId: "partial-provider-order",
                brokerTradeId: null,
                requestedQuantity: 1,
                filledQuantity: 0.4,
                averageFillPrice: 4000,
              }
            : {
                status: "FILLED",
                brokerOrderId: "timeout-provider-order",
                brokerTradeId: null,
                requestedQuantity: 0.2,
                filledQuantity: 0.2,
                averageFillPrice: 60000,
              },
        recoverExposure: async (recovery) => {
          if (recovery.intent.id === restartIntent.id) {
            restartRecoveryCalls++;
            expect(
              "restart recovery reuses the recovery id persisted before process death",
              recovery.recoveryClientOrderId === "tc-rec-restart-stable",
            );
          } else {
            partialRecoveryCalls++;
            expect(
              "partial recovery requires cancellation before compensating reduction",
              recovery.plan.action === "CANCEL_REMAINDER_THEN_REDUCE",
            );
          }
          return {
            outcome: "FLATTENED" as const,
            brokerOrderId: `reduce-${recovery.intent.id}`,
            filledQuantity: recovery.plan.quantity,
            evidenceSource: "phase11-db-fixture",
          };
        },
      });
    await reconcile();
    await reconcile();
    const recoveredRows = await db
      .select()
      .from(executionIntentsTable)
      .where(
        inArray(executionIntentsTable.id, [restartIntent.id, partialIntent.id]),
      );
    expect(
      "full timeout fill and partial fill are durably flattened exactly once across replay",
      recoveredRows.every(
        (row) => row.state === "FLATTENED" && row.recoveryState === "CONFIRMED",
      ) &&
        restartRecoveryCalls === 1 &&
        partialRecoveryCalls === 1,
    );

    await setOperatorLiveMode({
      userId: userB.id,
      section: "crypto",
      mode: "EXIT_ONLY",
      reason: "Operator-owned drain must survive process restart",
    });
    const priorOwner = await claimLiveExecutionOwnership(userB.id, "crypto");
    const replacementOwner = await claimLiveExecutionOwnership(
      userB.id,
      "crypto",
    );
    const [afterRestart] = await db
      .select()
      .from(liveExecutionStatesTable)
      .where(eq(liveExecutionStatesTable.userId, userB.id));
    expect(
      "restart increments ownership generation and preserves operator Exit-Only",
      replacementOwner.generation === priorOwner.generation + 1 &&
        afterRestart?.operatingMode === "EXIT_ONLY" &&
        afterRestart.operatingModeSource === "OPERATOR",
    );
    const staleWorker = await evaluatePersistedLiveSafety({
      userId: userB.id,
      section: "crypto",
      executionAuthority: "binance_futures_live",
      marketType: "futures",
      symbol: "BTCUSDT",
      strategyId: "fixed",
      autopilot: false,
      command: {
        decisionId: "phase11:stale-worker",
        riskDecisionId: "phase11:risk",
        planFingerprint: "a".repeat(64),
        ownershipGeneration: priorOwner.generation,
        brainVersion: "brain-v0",
        idempotencyKey: "phase11-stale-worker-command",
      },
    });
    expect(
      "a prior process generation is fenced at the persisted Live boundary",
      !staleWorker.allowed && staleWorker.code === "STALE_EXECUTION_OWNER",
    );
  } finally {
    await cleanup();
  }

  console.log(
    failures === 0
      ? "\nphase11-live-safety integration: all checks passed"
      : `\nphase11-live-safety integration: ${failures} FAILED`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
