import { Router, type IRouter } from "express";
import {
  db,
  notificationsTable,
  platformRoleAssignmentsTable,
  recommendationsTable,
  tradesTable,
  userBinanceCredentialsTable,
  userOandaCredentialsTable,
  usersTable,
} from "@workspace/db";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { getOrCreateEngine } from "../lib/engineRegistry";
import { isDemoUser } from "../middleware/demoGuard";
import { buildDemoStatus } from "../lib/demoStatus";
import { forexDemoAvailable } from "../lib/execution/demoMarketData";
import { getFinancialAuthorizationIdentity } from "../middleware/auth";
import { getLiveExecutionHealth } from "../lib/execution/liveSafetyStore";
import {
  getAutopilotSnapshot,
  globalAutopilotSuspended,
} from "../lib/autopilot/store";

const router: IRouter = Router();

type Availability = "available" | "partial" | "stale" | "unavailable";

function metric(
  state: Availability,
  value: number | null,
  options: {
    unit: "currency" | "percent" | "count";
    source: string | null;
    observedAt: string | null;
    reason?: string;
  },
) {
  return {
    state,
    value,
    unit: options.unit,
    source: options.source,
    observedAt: options.observedAt,
    reason: options.reason ?? null,
  };
}

function environmentFor(config: {
  executionTarget: string;
  testnet: boolean;
  broker: string;
}): {
  id:
    | "CACTUS_DEMO"
    | "BINANCE_TESTNET"
    | "BINANCE_LIVE"
    | "OANDA_PRACTICE"
    | "OANDA_LIVE";
  label: string;
  realFunds: boolean;
} {
  if (config.executionTarget === "demo") {
    return { id: "CACTUS_DEMO", label: "Cactus Demo", realFunds: false };
  }
  if (config.broker === "oanda") {
    return config.testnet
      ? { id: "OANDA_PRACTICE", label: "OANDA Practice", realFunds: false }
      : { id: "OANDA_LIVE", label: "OANDA Live", realFunds: true };
  }
  return config.testnet
    ? { id: "BINANCE_TESTNET", label: "Binance Testnet", realFunds: false }
    : { id: "BINANCE_LIVE", label: "Binance Live", realFunds: true };
}

function safeMinorCurrency(value: string | null): number | null {
  if (value === null || !/^-?\d+$/.test(value)) return null;
  const minor = Number(value);
  return Number.isSafeInteger(minor) ? minor / 100 : null;
}

function maskPreview(preview: string | null | undefined): string | null {
  return preview ? `••••${preview.slice(-4)}` : null;
}

router.get("/capabilities", async (req, res): Promise<void> => {
  const userId = req.userId!;
  const section = req.section!;
  const engine = getOrCreateEngine(userId, section, { resumeIdleDemo: false });
  const config = await engine.loadConfig();
  const [user, financialIdentity, binance, oanda, platformRoles] =
    await Promise.all([
      db
        .select({ isDemo: usersTable.isDemo })
        .from(usersTable)
        .where(eq(usersTable.id, userId))
        .limit(1)
        .then((rows) => rows[0] ?? null),
      getFinancialAuthorizationIdentity(userId),
      db
        .select({ preview: userBinanceCredentialsTable.apiKeyPreview })
        .from(userBinanceCredentialsTable)
        .where(eq(userBinanceCredentialsTable.userId, userId))
        .limit(1)
        .then((rows) => rows[0] ?? null),
      db
        .select({ preview: userOandaCredentialsTable.accountIdPreview })
        .from(userOandaCredentialsTable)
        .where(eq(userOandaCredentialsTable.userId, userId))
        .limit(1)
        .then((rows) => rows[0] ?? null),
      db
        .select({ role: platformRoleAssignmentsTable.role })
        .from(platformRoleAssignmentsTable)
        .where(
          and(
            eq(platformRoleAssignmentsTable.userId, userId),
            eq(platformRoleAssignmentsTable.status, "ACTIVE"),
          ),
        ),
    ]);

  const brokerConfigured = section === "forex" ? oanda !== null : binance !== null;
  res.json({
    schemaVersion: "cactus-trader-capabilities-v1",
    section,
    financialRole: financialIdentity?.role ?? "UNKNOWN",
    readOnlyDemoAccount: user?.isDemo ?? false,
    modes: {
      manual: {
        supported: false,
        reason:
          "Manual entry is architecture-gated until the preview, revalidation, durable intent, execution, protection, reconciliation, and audit contract is complete.",
      },
      brain: { supported: true, backendMode: "research", canExecute: false },
      copilot: {
        supported: true,
        approvalRequired: true,
        canApprove: !user?.isDemo && financialIdentity?.role !== "VIEWER",
      },
      autopilot: {
        supported: true,
        uiSelectionGrantsAuthority: false,
        liveAuthorityEnabled: false,
      },
    },
    accounts: {
      multipleBrokerAccounts: false,
      demo: {
        supported: section === "crypto" || forexDemoAvailable(),
        label: "Cactus Demo",
      },
      broker: {
        provider: section === "forex" ? "oanda" : "binance",
        configured: brokerConfigured,
        maskedIdentifier: maskPreview(
          section === "forex" ? oanda?.preview : binance?.preview,
        ),
        environments:
          section === "forex"
            ? ["OANDA_PRACTICE", "OANDA_LIVE"]
            : ["BINANCE_TESTNET", "BINANCE_LIVE"],
      },
    },
    features: {
      dashboardSession: true,
      strategyModeAssignments: true,
      pendingOrders: false,
      pendingOrdersReason:
        "An authoritative broker/order projection is not provisioned in this baseline.",
      manualEntry: false,
      externalAiProviders: false,
      multipleBrokerAccounts: false,
      adminConsole: platformRoles.length > 0,
    },
    serverAuthoritative: true,
    generatedAt: new Date().toISOString(),
  });
});

router.get("/dashboard/session", async (req, res): Promise<void> => {
  const userId = req.userId!;
  const section = req.section!;
  const now = new Date();
  const engine = getOrCreateEngine(userId, section, { resumeIdleDemo: false });
  const config = await engine.loadConfig();
  const demoUser = await isDemoUser(userId);
  const runtime = demoUser
    ? await buildDemoStatus(userId, section)
    : engine.getState();
  const environment = environmentFor(config);

  const [openPositions, recentTrades, recommendations, notifications, performance] =
    await Promise.all([
      db
        .select({
          id: tradesTable.id,
          symbol: tradesTable.symbol,
          side: tradesTable.side,
          quantity: tradesTable.remainingQuantity,
          entryPrice: tradesTable.entryPrice,
          stopLoss: tradesTable.stopLoss,
          takeProfit: tradesTable.takeProfit,
          strategyId: tradesTable.strategyId,
          strategyName: tradesTable.strategyName,
          executionTarget: tradesTable.executionTarget,
          executionAuthority: tradesTable.executionAuthority,
          managementAuthority: tradesTable.managementAuthority,
          entryTime: tradesTable.entryTime,
        })
        .from(tradesTable)
        .where(
          and(
            eq(tradesTable.userId, userId),
            eq(tradesTable.section, section),
            eq(tradesTable.status, "open"),
            eq(tradesTable.isBacktest, false),
          ),
        )
        .orderBy(desc(tradesTable.entryTime)),
      db
        .select({
          id: tradesTable.id,
          symbol: tradesTable.symbol,
          side: tradesTable.side,
          pnl: tradesTable.pnl,
          status: tradesTable.status,
          strategyName: tradesTable.strategyName,
          executionTarget: tradesTable.executionTarget,
          exitReason: tradesTable.exitReason,
          entryTime: tradesTable.entryTime,
          exitTime: tradesTable.exitTime,
        })
        .from(tradesTable)
        .where(
          and(
            eq(tradesTable.userId, userId),
            eq(tradesTable.section, section),
            ne(tradesTable.status, "open"),
            eq(tradesTable.isBacktest, false),
          ),
        )
        .orderBy(desc(tradesTable.exitTime))
        .limit(8),
      db
        .select({
          id: recommendationsTable.id,
          symbol: recommendationsTable.symbol,
          side: recommendationsTable.side,
          confidence: recommendationsTable.confidence,
          entryPrice: recommendationsTable.entryPrice,
          stopLoss: recommendationsTable.slPrice,
          takeProfit: recommendationsTable.tpPrice,
          quantity: recommendationsTable.qty,
          strategyId: recommendationsTable.strategyId,
          strategyName: recommendationsTable.strategyName,
          executionTarget: recommendationsTable.executionTarget,
          status: recommendationsTable.status,
          expiresAt: recommendationsTable.expiresAt,
          createdAt: recommendationsTable.createdAt,
        })
        .from(recommendationsTable)
        .where(
          and(
            eq(recommendationsTable.userId, userId),
            eq(recommendationsTable.section, section),
            eq(recommendationsTable.status, "created"),
          ),
        )
        .orderBy(desc(recommendationsTable.createdAt))
        .limit(5),
      db
        .select({
          id: notificationsTable.id,
          severity: notificationsTable.severity,
          type: notificationsTable.type,
          message: notificationsTable.message,
          createdAt: notificationsTable.createdAt,
          readAt: notificationsTable.readAt,
        })
        .from(notificationsTable)
        .where(
          and(
            eq(notificationsTable.userId, userId),
            eq(notificationsTable.section, section),
          ),
        )
        .orderBy(desc(notificationsTable.createdAt))
        .limit(10),
      db.execute(sql`
        SELECT execution_target,
               COUNT(*)::int AS sample_size,
               COALESCE(SUM(pnl), 0)::float AS total_pnl,
               SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END)::int AS wins
        FROM trades
        WHERE user_id = ${userId}
          AND section = ${section}
          AND is_backtest = false
          AND status <> 'open'
          AND pnl IS NOT NULL
        GROUP BY execution_target
      `),
    ]);

  let liveHealth: Awaited<ReturnType<typeof getLiveExecutionHealth>> | null = null;
  let liveHealthFailure: string | null = null;
  if (config.executionTarget === "live") {
    try {
      liveHealth = await getLiveExecutionHealth(userId, section);
    } catch {
      liveHealthFailure =
        "Persisted Live execution health could not be established; Live entry state is unknown.";
    }
  }

  const equityFresh =
    liveHealth?.state.equityFreshUntil != null &&
    liveHealth.state.equityFreshUntil.getTime() > now.getTime();
  const equityValue = equityFresh
    ? safeMinorCurrency(liveHealth!.state.currentEquityMinor)
    : null;
  const peakValue = equityFresh
    ? safeMinorCurrency(liveHealth!.state.peakEquityMinor)
    : null;
  const drawdownValue =
    equityValue !== null && peakValue !== null && peakValue > 0
      ? Math.max(0, ((peakValue - equityValue) / peakValue) * 100)
      : null;

  let autopilot: null | {
    configured: true;
    effectiveState: string;
    reason: string;
    globalSuspended: boolean;
    mandateId: number | null;
    mandateFingerprint: string | null;
    authorizedStrategies: string[];
    expiresAt: string | null;
  } = null;
  if (config.mode === "autopilot") {
    const snapshot = await getAutopilotSnapshot(userId, section);
    autopilot = {
      configured: true,
      effectiveState: snapshot.control.state,
      reason: snapshot.control.reason,
      globalSuspended: globalAutopilotSuspended(),
      mandateId: snapshot.mandate?.id ?? null,
      mandateFingerprint: snapshot.mandate?.fingerprint ?? null,
      authorizedStrategies: snapshot.mandate
        ? Object.keys(snapshot.mandate.strategyVersions)
        : [],
      expiresAt: snapshot.mandate?.expiresAt ?? null,
    };
  }

  const scanTime = runtime.lastScanAt ? Date.parse(runtime.lastScanAt) : NaN;
  const maximumScanAgeMs = Math.max(30_000, config.scanIntervalSeconds * 3_000);
  const marketDataAgeMs = Number.isFinite(scanTime)
    ? now.getTime() - scanTime
    : null;
  const marketDataState: Availability =
    marketDataAgeMs === null
      ? "unavailable"
      : marketDataAgeMs > maximumScanAgeMs
        ? "stale"
        : "available";

  const alerts: Array<{
    id: string;
    severity: "info" | "warning" | "critical";
    source: string;
    message: string;
    occurredAt: string;
    persistent: boolean;
  }> = notifications.map((notification) => ({
    id: `notification:${notification.id}`,
    severity:
      notification.severity === "critical"
        ? "critical"
        : notification.severity === "info"
          ? "info"
          : "warning",
    source: notification.type,
    message: notification.message,
    occurredAt: notification.createdAt.toISOString(),
    persistent: notification.readAt === null,
  }));
  if (runtime.riskPaused) {
    alerts.unshift({
      id: "runtime:risk-paused",
      severity: "critical",
      source: "risk",
      message:
        "Risk suspension is active. New entries are paused; protective position management continues.",
      occurredAt: now.toISOString(),
      persistent: true,
    });
  }
  if (environment.realFunds && !runtime.newEntriesAllowed) {
    alerts.unshift({
      id: "runtime:live-entry-blocked",
      severity: "critical",
      source: "execution",
      message:
        runtime.entryBlockReason ??
        "Live new entries are blocked. Existing protective management remains active.",
      occurredAt: now.toISOString(),
      persistent: true,
    });
  }
  if (marketDataState === "stale") {
    alerts.unshift({
      id: "runtime:market-data-stale",
      severity: "warning",
      source: "market-data",
      message: "Market data is stale. Do not treat displayed prices or signals as current.",
      occurredAt: runtime.lastScanAt ?? now.toISOString(),
      persistent: true,
    });
  }
  if (liveHealthFailure) {
    alerts.unshift({
      id: "runtime:execution-health-unknown",
      severity: "critical",
      source: "execution",
      message: liveHealthFailure,
      occurredAt: now.toISOString(),
      persistent: true,
    });
  }

  const performanceRows = (
    (performance as unknown as { rows?: Array<Record<string, unknown>> }).rows ??
    (performance as unknown as Array<Record<string, unknown>>)
  );
  const performanceByTarget = Object.fromEntries(
    performanceRows.map((row) => {
      const sampleSize = Number(row.sample_size ?? 0);
      const wins = Number(row.wins ?? 0);
      return [
        String(row.execution_target ?? "unknown"),
        {
          sampleSize,
          totalPnl: Number(row.total_pnl ?? 0),
          winRate: sampleSize > 0 ? wins / sampleSize : null,
        },
      ];
    }),
  );

  res.json({
    schemaVersion: "cactus-dashboard-session-v1",
    asOf: now.toISOString(),
    context: {
      section,
      market: section === "forex" ? "Forex" : "Crypto",
      broker: config.broker,
      marketType: config.marketType,
      environment,
      account: {
        id: `${environment.id}:${section}`,
        label: environment.label,
        singleConnectionPerMarket: true,
      },
      mode: {
        configured:
          config.mode === "research"
            ? "brain"
            : config.mode === "copilot"
              ? "copilot"
              : "autopilot",
        backendValue: config.mode,
        effectiveAuthority:
          config.mode === "research"
            ? "ANALYSIS_ONLY"
            : config.mode === "copilot"
              ? "USER_APPROVAL_REQUIRED"
              : (autopilot?.effectiveState ?? "NOT_AUTHORIZED"),
      },
    },
    metrics: {
      availableFunds: runtime.balanceUsdt !== null
        ? metric("available", runtime.balanceUsdt, {
            unit: "currency",
            source:
              config.executionTarget === "demo"
                ? "cactus-demo-ledger"
                : "broker-free-balance",
            observedAt: runtime.lastScanAt,
          })
        : metric("unavailable", null, {
            unit: "currency",
            source: null,
            observedAt: null,
            reason: "The engine has no current account free-balance observation.",
          }),
      equity: equityValue !== null
        ? metric("available", equityValue, {
            unit: "currency",
            source: liveHealth?.state.equitySource ?? null,
            observedAt: liveHealth?.state.equityObservedAt?.toISOString() ?? null,
          })
        : metric("unavailable", null, {
            unit: "currency",
            source: null,
            observedAt: null,
            reason:
              config.executionTarget === "demo"
                ? "Cactus Demo does not yet expose an authoritative marked-equity projection; available funds are shown separately."
                : "Authoritative broker equity is missing or stale.",
          }),
      marginUsed: metric("unavailable", null, {
        unit: "currency",
        source: null,
        observedAt: null,
        reason: "Authoritative account margin usage is not provisioned in this baseline.",
      }),
      realizedDayPnl: metric("available", runtime.dailyPnl, {
        unit: "currency",
        source: "trade-ledger",
        observedAt: now.toISOString(),
      }),
      exposure: metric("unavailable", null, {
        unit: "currency",
        source: null,
        observedAt: null,
        reason:
          "Open positions are available, but an authoritative marked account exposure total is not provisioned.",
      }),
      drawdown: drawdownValue !== null
        ? metric("available", drawdownValue, {
            unit: "percent",
            source: liveHealth?.state.equitySource ?? null,
            observedAt: liveHealth?.state.equityObservedAt?.toISOString() ?? null,
          })
        : metric("unavailable", null, {
            unit: "percent",
            source: null,
            observedAt: null,
            reason: "A fresh authoritative peak and current equity are required.",
          }),
      risk: {
        state: runtime.riskPaused
          ? "SUSPENDED"
          : runtime.newEntriesAllowed
            ? "CLEAR"
            : "BLOCKED",
        newEntriesAllowed: runtime.newEntriesAllowed,
        protectiveManagementContinues: true,
        reason: runtime.entryBlockReason,
      },
    },
    runtime: {
      running: runtime.running,
      startedAt: runtime.startedAt,
      lastScanAt: runtime.lastScanAt,
      circuitBreakerActive: runtime.circuitBreakerActive,
      openPositionCount: openPositions.length,
      tradesToday: runtime.totalTradesToday,
    },
    health: {
      api: { state: "available", label: "Connected" },
      database: { state: "available", label: "Connected" },
      broker: {
        state: runtime.running ? "available" : "unavailable",
        label: runtime.running ? "Runtime connected" : "Runtime stopped",
        reason: runtime.running ? null : "Broker connectivity is not asserted while the engine is stopped.",
      },
      marketData: {
        state: marketDataState,
        observedAt: runtime.lastScanAt,
        ageMs: marketDataAgeMs,
        reason:
          marketDataState === "available"
            ? null
            : marketDataState === "stale"
              ? "The last engine scan is older than the section freshness budget."
              : "No market-data observation is available.",
      },
      execution: {
        state:
          config.executionTarget === "demo"
            ? "available"
            : liveHealthFailure
              ? "unavailable"
              : liveHealth?.state.operatingMode === "NORMAL" && runtime.newEntriesAllowed
                ? "available"
                : "partial",
        label:
          config.executionTarget === "demo"
            ? "Simulated execution"
            : liveHealth?.state.operatingMode ?? "Unknown",
        reason: liveHealthFailure ?? runtime.entryBlockReason,
      },
    },
    activity: {
      positions: openPositions.map((position) => ({
        ...position,
        quantity: Number(position.quantity ?? 0),
        entryPrice: Number(position.entryPrice),
        stopLoss: Number(position.stopLoss),
        takeProfit: Number(position.takeProfit),
        side: position.side === "sell" ? "short" : "long",
        entryTime: position.entryTime.toISOString(),
      })),
      pendingOrders: {
        state: "unavailable",
        orders: null,
        reason:
          "An authoritative pending-order projection with broker verification is not provisioned.",
      },
      recentTrades: recentTrades.map((trade) => ({
        ...trade,
        pnl: trade.pnl === null ? null : Number(trade.pnl),
        side: trade.side === "sell" ? "short" : "long",
        entryTime: trade.entryTime.toISOString(),
        exitTime: trade.exitTime?.toISOString() ?? null,
      })),
      recommendations: recommendations.map((recommendation) => ({
        ...recommendation,
        confidence: Number(recommendation.confidence),
        entryPrice: Number(recommendation.entryPrice),
        stopLoss: Number(recommendation.stopLoss),
        takeProfit: Number(recommendation.takeProfit),
        quantity: Number(recommendation.quantity),
        expiresAt: recommendation.expiresAt.toISOString(),
        createdAt: recommendation.createdAt.toISOString(),
        approvalRequired: true,
      })),
    },
    performance: {
      live: performanceByTarget["live"] ?? {
        sampleSize: 0,
        totalPnl: 0,
        winRate: null,
      },
      demo: performanceByTarget["demo"] ?? {
        sampleSize: 0,
        totalPnl: 0,
        winRate: null,
      },
      separatedByExecutionTarget: true,
    },
    autopilot,
    alerts,
    limitations: [
      "Pending orders are unavailable until a broker-verified projection exists.",
      "Manual entry is not exposed until its separately approved financial-path milestone is complete.",
      "Available funds, equity, margin, exposure, and research projections are never treated as interchangeable values.",
    ],
  });
});

export default router;
