// ---------------------------------------------------------------------------
// Decision-trace + live-market-monitor types
//
// These power two verification surfaces on the dashboard:
//   1. Live Market Monitor  — real Binance ticker data + connection health
//   2. Strategy Decision Panel — the full per-symbol pipeline
//        (market data → indicators → signal → risk checks → order)
//      with the *exact* reason a trade was or was not taken.
// ---------------------------------------------------------------------------

/** Outcome of a single pipeline stage for one symbol on one scan. */
export type StageStatus = "pass" | "fail" | "skip";

/** One of the five canonical pipeline stages. */
export interface PipelineStage {
  /** "Market Data" | "Indicators" | "Signal" | "Risk Checks" | "Order" */
  name: string;
  status: StageStatus;
  /** Human-readable one-line explanation of what happened at this stage. */
  detail: string;
  /** Stage-specific structured values (indicator numbers, risk checklist, etc.). */
  data?: Record<string, unknown>;
}

/** A single named risk check with its pass/fail result. */
export interface RiskCheck {
  name: string;
  passed: boolean;
  detail: string;
}

/** The full pipeline decision for one symbol on the most recent scan. */
export interface SymbolDecision {
  symbol: string;
  timestamp: string;
  /** Model confidence (0–100) from the indicator vote, 0 when not computed. */
  confidence: number;
  /** ENTERED = trade taken (or position already open); BLOCKED = no entry. */
  finalDecision: "ENTERED" | "BLOCKED";
  /** Which stage stopped the trade (null when entered). */
  blockStage: string | null;
  /** The exact condition that blocked the trade (null when entered). */
  blockReason: string | null;
  stages: PipelineStage[];
}

/** Real-time ticker snapshot for one symbol. */
export interface LiveTicker {
  symbol: string;
  last: number;
  bid: number;
  ask: number;
  spread: number;
  spreadPercent: number;
  /** 24h base-asset volume. */
  baseVolume: number;
  /** 24h quote-asset (USDT) volume. */
  quoteVolume: number;
  /** 24h price change percent. */
  changePercent: number;
  /** Exchange timestamp of the quote (ms since epoch). */
  timestamp: number;
}

/** Exchange connection health for the live monitor. */
export interface ConnectionStatus {
  connected: boolean;
  mode: "live" | "testnet" | "backtest";
  exchange: string;
  marketsLoaded: number;
  credentialsVerified: boolean;
  lastTickerFetchAt: string | null;
  lastTickerLatencyMs: number | null;
  lastError: string | null;
}

export interface MarketMonitor {
  connection: ConnectionStatus;
  tickers: LiveTicker[];
}

/** Aggregated "why is nothing trading" summary across all evaluated symbols. */
export interface BlockingSummary {
  /** True when at least one entry happened or the engine is actively able to trade. */
  tradingActive: boolean;
  running: boolean;
  /** Engine-wide block (circuit breaker, risk pause, stopped, all blacklisted) — null if none. */
  globalBlock: string | null;
  /** Number of symbols that resulted in an entry this scan. */
  entered: number;
  /** Number of symbols evaluated this scan. */
  totalEvaluated: number;
  /** Per-reason breakdown of blocked symbols, most common first. */
  reasons: { stage: string; reason: string; count: number; symbols: string[] }[];
  lastScanAt: string | null;
}
