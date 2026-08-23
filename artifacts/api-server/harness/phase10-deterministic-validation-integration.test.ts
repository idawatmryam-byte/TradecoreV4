/** PostgreSQL-backed complete deterministic Phase 10 simulated Demo lifecycle. */
export {};

if (!process.env.DATABASE_URL) {
  console.log(
    "phase10 deterministic validation integration SKIPPED (no DATABASE_URL)",
  );
  process.exit(0);
}

const { and, eq, sql } = await import("drizzle-orm");
const {
  autopilotDecisionClaimsTable,
  autopilotEventsTable,
  botConfigTable,
  db,
  executionIntentsTable,
  positionManagementEventsTable,
  tradesTable,
} = await import("@workspace/db");
const { randomUUID } = await import("node:crypto");
const { BotEngine } = await import("../src/lib/botEngine");
const { loadStrategyConfigs } = await import("../src/lib/strategyConfigLoader");
const { autopilotConfigFingerprint, strategyConfigVersion } =
  await import("../src/lib/autopilot/fingerprints");
const {
  createMandate,
  ensureBrainV0Version,
  setAutopilotState,
  transitionBrainVersion,
} = await import("../src/lib/autopilot/store");
const {
  confirmPhase10ValidationGlobalSuspension,
  runPhase10ValidationAfterRestart,
  runPhase10ValidationBeforeRestart,
} = await import("../src/lib/autopilot/validationRunner");
const { authorizePhase10Validation, PHASE10_VALIDATION_CONFIRMATION } =
  await import("../src/lib/autopilot/validation");

const USER = 990012;
const TOKEN = "phase10-integration-operator-token-0000000000000000";
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
  // purge_user_data does not remove bot_config or trades; leaving either
  // behind breaks reruns on any database that is not freshly provisioned
  // (bot_config_user_section_unique / "exactly one simulated trade").
  await db
    .delete(botConfigTable)
    .where(
      and(eq(botConfigTable.userId, USER), eq(botConfigTable.section, "crypto")),
    );
  await db.delete(tradesTable).where(eq(tradesTable.userId, USER));
}

async function main() {
  const previous = {
    enabled: process.env.PHASE10_VALIDATION_ENABLED,
    token: process.env.PHASE10_VALIDATION_TOKEN,
    suspended: process.env.AUTOPILOT_GLOBAL_SUSPENDED,
  };
  process.env.PHASE10_VALIDATION_ENABLED = "true";
  process.env.PHASE10_VALIDATION_TOKEN = TOKEN;
  process.env.AUTOPILOT_GLOBAL_SUSPENDED = "false";
  await cleanup();
  try {
    const [config] = await db
      .insert(botConfigTable)
      .values({
        userId: USER,
        section: "crypto",
        broker: "binance",
        marketType: "spot",
        pairs: "BTCUSDT",
        executionTarget: "demo",
        mode: "autopilot",
        positionManagementMode: "phase7_active",
        positionSizeUsdt: "100",
        maxOpenPositions: 1,
        maxPortfolioRiskPercent: "5",
        maxSymbolConcentrationPercent: "50",
        maxNetExposurePercent: "50",
        maxCorrelatedExposurePercent: "50",
        dailyLossLimitUsdt: "100",
        demoStartingBalanceUsdt: "10000",
        activated: true,
        engineDesiredRunning: false,
        testnet: true,
      })
      .returning();
    if (!config) throw new Error("Validation bot config was not created");
    const strategyConfigs = await loadStrategyConfigs(USER, "crypto");
    const strategy = strategyConfigs.get("trend_pullback");
    if (!strategy) throw new Error("trend_pullback config was not available");
    const brain = await ensureBrainV0Version(USER, "crypto");
    const approved = await transitionBrainVersion({
      userId: USER,
      section: "crypto",
      versionId: brain.id,
      toState: "DEMO_APPROVED",
      reason:
        "Integration operator approved exact Brain V0 for deterministic simulated Demo validation",
      actorUserId: USER,
    });
    const mandate = await createMandate(
      {
        schemaVersion: "phase10-demo-autopilot-v1",
        userId: USER,
        section: "crypto",
        version: 1,
        botConfigId: config.id,
        configFingerprint: autopilotConfigFingerprint(config),
        brainVersionId: approved.id,
        brainVersion: "brain-v0",
        executionAuthority: "simulated_demo",
        marketType: "spot",
        instruments: ["BTCUSDT"],
        strategyVersions: {
          trend_pullback: strategyConfigVersion("trend_pullback", strategy),
        },
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
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      },
      USER,
    );
    await setAutopilotState({
      userId: USER,
      section: "crypto",
      state: "AUTOPILOT_ENABLED",
      reasonCode: "HUMAN_ACTIVATION_APPROVED",
      reason:
        "Integration operator enabled the short-lived deterministic simulated Demo mandate",
      actor: { actorType: "user", actorUserId: USER },
      mandateId: mandate.id,
      configSuspended: false,
      globalSuspended: false,
    });

    const runId = randomUUID();
    const authorization = authorizePhase10Validation({
      runId,
      operatorUserId: USER,
      confirmation: PHASE10_VALIDATION_CONFIRMATION,
      token: TOKEN,
    });
    const input = {
      authorization,
      userId: USER,
      section: "crypto" as const,
      mandateId: mandate.id,
      symbol: "BTCUSDT",
      strategyId: "trend_pullback",
    };
    const before = await runPhase10ValidationBeforeRestart(input);
    expect(
      "one deterministic autonomous entry was persisted",
      Number.isInteger(before.tradeId) &&
        Number.isInteger(before.intentId) &&
        Number.isInteger(before.claimId),
    );
    expect(
      "the in-path duplicate probe was refused",
      before.duplicateRefused === true,
    );

    // A new engine object is deliberately created inside the after-restart
    // workflow, so no mutable BotEngine state from the entry can be reused.
    const after = await runPhase10ValidationAfterRestart(input);
    expect(
      "consumed claim survives engine reload",
      after.claimStatus === "EXECUTED",
    );
    expect(
      "restart does not create a duplicate trade",
      after.duplicateTradeCount === 1,
    );
    expect(
      "Phase 7 projection reloads",
      after.managementProjectionReloaded === true,
    );
    expect(
      "trade closes through simulated Demo",
      after.finalTradeStatus !== "open",
    );
    expect(
      "normal autonomous entries are paused after validation",
      after.autopilotPaused === true,
    );

    const claims = await db
      .select()
      .from(autopilotDecisionClaimsTable)
      .where(eq(autopilotDecisionClaimsTable.userId, USER));
    const intents = await db
      .select()
      .from(executionIntentsTable)
      .where(eq(executionIntentsTable.userId, USER));
    const trades = await db
      .select()
      .from(tradesTable)
      .where(eq(tradesTable.userId, USER));
    const managementEvents = await db
      .select()
      .from(positionManagementEventsTable)
      .where(eq(positionManagementEventsTable.userId, USER));
    expect(
      "exactly one executable claim exists",
      claims.filter((claim) => claim.status === "EXECUTED").length === 1,
    );
    expect(
      "exactly one protected intent exists",
      intents.length === 1 && intents[0]?.state === "PROTECTED",
    );
    expect(
      "exactly one simulated trade exists",
      trades.length === 1 && trades[0]?.executionAuthority === "simulated_demo",
    );
    expect(
      "Phase 7 emitted durable management evidence",
      managementEvents.length > 0,
    );

    process.env.AUTOPILOT_GLOBAL_SUSPENDED = "true";
    const suspendedAuthorization = authorizePhase10Validation({
      runId,
      operatorUserId: USER,
      confirmation: PHASE10_VALIDATION_CONFIRMATION,
      token: TOKEN,
      requiresGlobalSuspension: "active",
    });
    const final = await confirmPhase10ValidationGlobalSuspension({
      ...input,
      authorization: suspendedAuthorization,
    });
    expect(
      "global suspension restoration is confirmed",
      final.globalSuspended && final.externalProviderMutation === false,
    );
    const lifecycleEvents = await db
      .select()
      .from(autopilotEventsTable)
      .where(
        and(
          eq(autopilotEventsTable.userId, USER),
          eq(autopilotEventsTable.section, "crypto"),
        ),
      );
    expect(
      "validation lifecycle is append-only audited",
      [
        "PHASE10_VALIDATION_ENTRY_SUCCEEDED",
        "PHASE10_VALIDATION_MANAGEMENT_PERSISTED",
        "PHASE10_VALIDATION_RELOAD_VERIFIED",
        "PHASE10_VALIDATION_CLOSE_SUCCEEDED",
        "PHASE10_VALIDATION_COMPLETED",
        "PHASE10_VALIDATION_GLOBAL_SUSPENSION_RESTORED",
      ].every((eventType) =>
        lifecycleEvents.some((event) => event.eventType === eventType),
      ),
    );

    // Defense in depth: the exact method itself refuses a Live configuration.
    await db
      .update(botConfigTable)
      .set({ executionTarget: "live", testnet: false })
      .where(eq(botConfigTable.id, config.id));
    let liveRefused = false;
    try {
      await new BotEngine(USER, "crypto").runPhase10ValidationScan({
        authorization: suspendedAuthorization,
        stage: "entry",
        mandateId: mandate.id,
        symbol: "BTCUSDT",
        strategyId: "trend_pullback",
      });
    } catch {
      liveRefused = true;
    }
    expect(
      "validation method categorically refuses Live authority",
      liveRefused,
    );
  } finally {
    await cleanup();
    if (previous.enabled === undefined)
      delete process.env.PHASE10_VALIDATION_ENABLED;
    else process.env.PHASE10_VALIDATION_ENABLED = previous.enabled;
    if (previous.token === undefined)
      delete process.env.PHASE10_VALIDATION_TOKEN;
    else process.env.PHASE10_VALIDATION_TOKEN = previous.token;
    if (previous.suspended === undefined)
      delete process.env.AUTOPILOT_GLOBAL_SUSPENDED;
    else process.env.AUTOPILOT_GLOBAL_SUSPENDED = previous.suspended;
  }
  console.log(
    failures === 0
      ? "\nphase10 deterministic validation integration: all checks passed"
      : `\nphase10 deterministic validation integration: ${failures} FAILED`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
