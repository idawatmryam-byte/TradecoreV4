import { sectionHeaders, type Section } from "@/lib/section";

export type Availability = "available" | "partial" | "stale" | "unavailable";

export interface MetricValue {
  state: Availability;
  value: number | null;
  unit: "currency" | "percent" | "count";
  source: string | null;
  observedAt: string | null;
  reason: string | null;
}

export interface TraderCapabilities {
  schemaVersion: "cactus-trader-capabilities-v1";
  section: Section;
  financialRole: string;
  readOnlyDemoAccount: boolean;
  modes: {
    manual: { supported: false; reason: string };
    brain: { supported: boolean; backendMode: "research"; canExecute: false };
    copilot: { supported: boolean; approvalRequired: true; canApprove: boolean };
    autopilot: {
      supported: boolean;
      uiSelectionGrantsAuthority: false;
      liveAuthorityEnabled: boolean;
    };
  };
  accounts: {
    multipleBrokerAccounts: false;
    demo: { supported: boolean; label: string };
    broker: {
      provider: "binance" | "oanda";
      configured: boolean;
      maskedIdentifier: string | null;
      environments: string[];
    };
  };
  features: {
    dashboardSession: boolean;
    strategyModeAssignments: boolean;
    pendingOrders: boolean;
    pendingOrdersReason: string;
    manualEntry: boolean;
    externalAiProviders: boolean;
    multipleBrokerAccounts: boolean;
    adminConsole: boolean;
  };
  serverAuthoritative: true;
  generatedAt: string;
}

export interface DashboardPosition {
  id: number;
  symbol: string;
  side: "long" | "short";
  quantity: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  strategyId: string | null;
  strategyName: string | null;
  executionTarget: "demo" | "live";
  executionAuthority: string | null;
  managementAuthority: string | null;
  entryTime: string;
}

export interface DashboardRecommendation {
  id: number;
  symbol: string;
  side: "long" | "short";
  confidence: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  quantity: number;
  strategyId: string | null;
  strategyName: string | null;
  executionTarget: "demo" | "live";
  status: string;
  expiresAt: string;
  createdAt: string;
  approvalRequired: true;
}

export interface DashboardSession {
  schemaVersion: "cactus-dashboard-session-v1";
  asOf: string;
  context: {
    section: Section;
    market: "Crypto" | "Forex";
    broker: "binance" | "oanda";
    marketType: string;
    environment: {
      id:
        | "CACTUS_DEMO"
        | "BINANCE_TESTNET"
        | "BINANCE_LIVE"
        | "OANDA_PRACTICE"
        | "OANDA_LIVE";
      label: string;
      realFunds: boolean;
    };
    account: { id: string; label: string; singleConnectionPerMarket: true };
    mode: {
      configured: "brain" | "copilot" | "autopilot";
      backendValue: "research" | "copilot" | "autopilot";
      effectiveAuthority: string;
    };
  };
  metrics: {
    availableFunds: MetricValue;
    equity: MetricValue;
    marginUsed: MetricValue;
    realizedDayPnl: MetricValue;
    exposure: MetricValue;
    drawdown: MetricValue;
    risk: {
      state: "CLEAR" | "BLOCKED" | "SUSPENDED";
      newEntriesAllowed: boolean;
      protectiveManagementContinues: true;
      reason: string | null;
    };
  };
  runtime: {
    running: boolean;
    startedAt: string | null;
    lastScanAt: string | null;
    circuitBreakerActive: boolean;
    openPositionCount: number;
    tradesToday: number;
  };
  health: Record<
    "api" | "database" | "broker" | "marketData" | "execution",
    { state: Availability; label?: string; reason?: string | null; observedAt?: string | null; ageMs?: number | null }
  >;
  activity: {
    positions: DashboardPosition[];
    pendingOrders: { state: "unavailable"; orders: null; reason: string };
    recentTrades: Array<{
      id: number;
      symbol: string;
      side: "long" | "short";
      pnl: number | null;
      status: string;
      strategyName: string | null;
      executionTarget: "demo" | "live";
      exitReason: string | null;
      entryTime: string;
      exitTime: string | null;
    }>;
    recommendations: DashboardRecommendation[];
  };
  performance: {
    live: { sampleSize: number; totalPnl: number; winRate: number | null };
    demo: { sampleSize: number; totalPnl: number; winRate: number | null };
    separatedByExecutionTarget: true;
  };
  autopilot: null | {
    configured: true;
    effectiveState: string;
    reason: string;
    globalSuspended: boolean;
    mandateId: number | null;
    mandateFingerprint: string | null;
    authorizedStrategies: string[];
    expiresAt: string | null;
  };
  alerts: Array<{
    id: string;
    severity: "info" | "warning" | "critical";
    source: string;
    message: string;
    occurredAt: string;
    persistent: boolean;
  }>;
  limitations: string[];
}

export interface StrategyAssignment {
  strategyId: string;
  brain: boolean;
  copilot: boolean;
  autopilot: boolean;
  revision: number;
  updatedAt: string | null;
}

export interface StrategyCatalogItem {
  strategyId: string;
  strategyName: string;
  version: string;
  fingerprint: string;
  kind: "built-in" | "custom";
  supportedMarket: Section;
  backtested?: boolean;
  config: { enabled: boolean } & Record<string, unknown>;
  assignment: StrategyAssignment;
  performance: {
    totalTrades: number;
    winRate: number | null;
    totalPnl: number;
  };
}

export class TraderApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null = null,
  ) {
    super(message);
  }
}

export async function traderApi<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    credentials: "same-origin",
    headers: {
      ...sectionHeaders(),
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const payload = (await response.json().catch(() => null)) as
    | { error?: unknown; code?: unknown }
    | null;
  if (!response.ok) {
    throw new TraderApiError(
      typeof payload?.error === "string" ? payload.error : "The server refused this request.",
      response.status,
      typeof payload?.code === "string" ? payload.code : null,
    );
  }
  return payload as T;
}
