/** PostgreSQL-backed regression for durable suspended-activation refusal audit. */
export {};

if (!process.env.DATABASE_URL) {
  console.log(
    "autopilot activation refusal integration SKIPPED (no DATABASE_URL)",
  );
  process.exit(0);
}

const { and, eq, sql } = await import("drizzle-orm");
const {
  autopilotDecisionClaimsTable,
  autopilotEventsTable,
  autopilotMandateStatesTable,
  db,
  executionIntentsTable,
  tradesTable,
} = await import("@workspace/db");
const {
  createMandate,
  ensureBrainV0Version,
  getAutopilotSnapshot,
  refuseAutopilotActivationWhileGloballySuspended,
  setAutopilotState,
  transitionBrainVersion,
} = await import("../src/lib/autopilot/store");

const USER = 990011;
let failures = 0;
function expect(name: string, condition: boolean, detail = "") {
  if (!condition) failures++;
  console.log(
    `${condition ? "✓" : "✗ FAIL"}  ${name}${condition ? "" : `  ${detail}`}`,
  );
}

async function cleanup() {
  await db.execute(sql`SELECT capture.purge_user_data(${USER})`);
  await db
    .delete(executionIntentsTable)
    .where(eq(executionIntentsTable.userId, USER));
}

async function main() {
  await cleanup();
  try {
    const brain = await ensureBrainV0Version(USER, "crypto");
    const approved = await transitionBrainVersion({
      userId: USER,
      section: "crypto",
      versionId: brain.id,
      toState: "DEMO_APPROVED",
      reason:
        "Regression operator approved Brain V0 for simulated Demo refusal testing",
      actorUserId: USER,
    });
    const mandate = await createMandate(
      {
        schemaVersion: "phase10-demo-autopilot-v1",
        userId: USER,
        section: "crypto",
        version: 1,
        botConfigId: 100,
        configFingerprint: "a".repeat(64),
        brainVersionId: approved.id,
        brainVersion: "brain-v0",
        executionAuthority: "simulated_demo",
        marketType: "spot",
        instruments: ["BTCUSDT"],
        strategyVersions: { trend_pullback: "strategy-config:fixture" },
        maximumPositionSizeUsdt: 100,
        maximumLeverage: 1,
        maximumPortfolioRiskPercent: 5,
        maximumSymbolExposurePercent: 50,
        maximumNetExposurePercent: 50,
        maximumCorrelatedExposurePercent: 50,
        dailyLossLimitUsdt: 100,
        maximumDrawdownPercent: 10,
        maximumConcurrentPositions: 1,
        maximumMarketDataAgeSeconds: 30,
        allowedTradingHoursUtc: [],
        permittedPhase7Actions: [
          "HOLD",
          "FREEZE",
          "REDUCE",
          "TIGHTEN_STOP",
          "APPLY_TRAILING",
          "EXIT",
        ],
        validFrom: new Date(Date.now() - 1_000).toISOString(),
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      },
      USER,
    );
    await setAutopilotState({
      userId: USER,
      section: "crypto",
      state: "AUTOPILOT_ENABLED",
      reasonCode: "HUMAN_ACTIVATION_APPROVED",
      reason: "Regression operator enabled the exact simulated Demo mandate",
      actor: { actorType: "user", actorUserId: USER },
      mandateId: mandate.id,
      configSuspended: false,
      globalSuspended: false,
    });

    await refuseAutopilotActivationWhileGloballySuspended({
      userId: USER,
      section: "crypto",
      requestedMandateId: mandate.id,
      actorUserId: USER,
    });
    const snapshot = await getAutopilotSnapshot(USER, "crypto");
    expect(
      "global-suspension activation remains fail closed",
      snapshot.control.state === "AUTOPILOT_BLOCKED",
    );
    expect(
      "correct durable block reason is persisted",
      snapshot.control.reasonCode === "GLOBAL_SUSPENSION_ACTIVE" &&
        snapshot.control.globalSuspended &&
        snapshot.control.configSuspended,
    );
    expect(
      "active mandate is transactionally suspended",
      snapshot.mandateState?.state === "SUSPENDED" &&
        snapshot.mandateState.reasonCode === "GLOBAL_SUSPENSION_ACTIVE",
    );

    const refusalEvents = await db
      .select()
      .from(autopilotEventsTable)
      .where(
        and(
          eq(autopilotEventsTable.userId, USER),
          eq(autopilotEventsTable.section, "crypto"),
          eq(autopilotEventsTable.eventType, "AUTOPILOT_ACTIVATION_REFUSED"),
        ),
      );
    expect(
      "activation refusal is append-only durable evidence",
      refusalEvents.length === 1 &&
        refusalEvents[0]?.reasonCode === "GLOBAL_SUSPENSION_ACTIVE",
    );
    const payload = refusalEvents[0]?.payload as Record<string, unknown> | null;
    expect(
      "refusal explicitly records no execution artifacts",
      payload?.claimCreated === false &&
        payload?.intentCreated === false &&
        payload?.tradeCreated === false,
    );

    const [claims, intents, trades] = await Promise.all([
      db
        .select()
        .from(autopilotDecisionClaimsTable)
        .where(eq(autopilotDecisionClaimsTable.userId, USER)),
      db
        .select()
        .from(executionIntentsTable)
        .where(eq(executionIntentsTable.userId, USER)),
      db.select().from(tradesTable).where(eq(tradesTable.userId, USER)),
    ]);
    expect("refused activation creates no claim", claims.length === 0);
    expect("refused activation creates no intent", intents.length === 0);
    expect("refused activation creates no trade", trades.length === 0);
  } finally {
    await cleanup();
  }
  console.log(
    failures === 0
      ? "\nautopilot activation refusal integration: all checks passed"
      : `\nautopilot activation refusal integration: ${failures} FAILED`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
