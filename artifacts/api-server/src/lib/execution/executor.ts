/**
 * TradeCore Pro — TradeExecutor: the single fork point after the TradePlan
 *
 * The intelligence pipeline ends when a strategy returns an approved
 * TradePlan. Everything before that point is identical no matter who is
 * trading or how; everything after it is *only* a question of what to do with
 * the plan. This interface is that boundary.
 *
 *   Market data → features → regime → strategy → risk → TRADE PLAN
 *                                                          │
 *                                            ┌─────────────┴─────────────┐
 *                                       LiveExecutor              (later)
 *                                     places real orders      DemoExecutor
 *                                                             RecommendExecutor
 *
 * The scan loop hands a finished plan to whichever executor is configured and
 * does not care what happens next. That is what lets Demo mode, Co-Pilot, and
 * Research share one engine rather than forking the intelligence.
 *
 * A deliberate note on scope: this introduces the SEAM, not a relocation.
 * BotEngine.enterTrade() is ~590 lines wired into a dozen engine internals
 * (exchange handle, balance, cooldowns, order-id tracking, ExitManager,
 * alerting). Physically moving it today would be a large diff across the money
 * path that buys no capability — the fork point is what unlocks the other
 * executors, and they need the *plan*, not enterTrade's internals. The body
 * moves later, incrementally, once DemoExecutor shows which parts are
 * genuinely shared.
 */
import type { SignalRow } from "../strategy";
import type { StrategyConfig, TradePlan } from "../strategies";
import type { PipelineStage, RiskCheck } from "../decisionTrace";
// Type-only: erased at compile time, so this does NOT create a runtime cycle
// with botEngine (which imports LiveExecutor).
import type { BotEngine } from "../botEngine";
import type { MarketState } from "../intelligence/market-state/types";
import type { ManagementAuthorityAssignment } from "../intelligence/position";
import type { ShadowCouncilRun } from "../intelligence/council";
import type { SpecialistCouncilSnapshot } from "../intelligence/specialists";
import type { PortfolioIntelligenceProjection } from "../intelligence/portfolio";

/** The engine's resolved per-scan configuration (market type, caps, cooldowns). */
export type RuntimeConfig = Awaited<ReturnType<BotEngine["loadConfig"]>>;

export interface PositionManagementContext {
  assignment: ManagementAuthorityAssignment;
  marketState: MarketState;
}

export interface CopilotSupervisionContext {
  readonly marketState: MarketState;
  readonly specialistCouncil: SpecialistCouncilSnapshot;
  readonly councilRun: ShadowCouncilRun;
  readonly portfolio: PortfolioIntelligenceProjection;
  readonly creationRiskChecks: readonly RiskCheck[];
}

/** Everything an executor needs to act on one approved plan. */
export interface ExecutionRequest {
  symbol: string;
  /** The approved, immutable plan. Executors must not mutate it. */
  plan: TradePlan;
  /** Indicator snapshot behind the decision — recorded, never re-derived. */
  row: SignalRow;
  /** Resolved bot config for this scan. */
  config: RuntimeConfig;
  /** Scan timestamp; the entry time of record. */
  now: Date;
  /** Per-strategy config (drives the TP1/TP2 ladder). */
  stratConfig?: StrategyConfig;
  /** Pinned authority and immutable entry MarketState for Phase 7 thesis
   * persistence. Absent only when fixed management is selected. */
  positionManagement?: PositionManagementContext;
  /**
   * The Market Data / Indicators / Signal / Risk Checks stages, already
   * finalized — reaching this call means all four passed. Only
   * RecommendExecutor uses this today (to snapshot the reasoning onto the
   * recommendation, since the live in-memory trace is overwritten every scan
   * tick); LiveExecutor and DemoExecutor ignore it, since a trades row's own
   * columns are that record for an executed position.
   */
  precedingStages?: PipelineStage[];
  /** Required by RecommendExecutor; ignored by non-Co-Pilot executors. */
  copilotSupervision?: CopilotSupervisionContext;
}

export interface ExecutionResult {
  /** True only when a position exists AND is tracked in the trades table. */
  entered: boolean;
  /** Human-readable outcome — surfaced in the decision trace and Decisions feed. */
  reason: string;
  /** Set when a position was opened; links the trade to its whole history. */
  correlationId?: string;
  /** Set when a trades row was written. */
  tradeId?: number;
}

export interface TradeExecutor {
  /**
   * What this executor does with a plan. Rendered in logs and, later, in the
   * UI — a user must always be able to tell a simulated fill from a real one.
   */
  readonly kind: "live" | "demo" | "recommend";
  execute(req: ExecutionRequest): Promise<ExecutionResult>;
}
