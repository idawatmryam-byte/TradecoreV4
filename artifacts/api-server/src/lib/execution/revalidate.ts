/**
 * TradeCore Pro — re-validation before executing an approved recommendation
 *
 * A Co-Pilot plan is a statement about a moment. Between the engine producing
 * it and the user pressing Execute, any of the things that made it safe can
 * have stopped being true: the price has moved, another position has opened,
 * the daily loss limit has been hit, the symbol has gone on cooldown after a
 * loss.
 *
 * Approving a plan therefore does NOT mean "place this order". It means
 * "re-ask the risk engine, right now, and place it only if the answer is still
 * yes". Without that, Co-Pilot would be strictly more dangerous than
 * AutoPilot: the same trade, taken later, with none of the checks re-run.
 *
 * Blocked is terminal. A recommendation that fails here does not go back to
 * the inbox for another try — the situation that produced it has passed.
 */

/** Reasons an approved plan can be refused at execution time. */
export type BlockCode =
  | "EXPIRED"
  | "NOT_ACTIONABLE"
  | "PRICE_UNAVAILABLE"
  | "PRICE_DRIFT"
  | "CIRCUIT_BREAKER"
  | "RISK_PAUSED"
  | "MAX_POSITIONS"
  | "STRATEGY_CONCURRENCY"
  | "PORTFOLIO_RISK"
  | "SYMBOL_COOLDOWN"
  | "BLACKLISTED"
  | "ALREADY_OPEN"
  | "ENGINE_STOPPED"
  | "PLAN_MUTATED"
  | "DECISION_BUNDLE_MUTATED"
  | "WRONG_MODE"
  | "TARGET_CHANGED"
  | "MARKET_DATA_STALE"
  | "MARKET_STATE_INVALID"
  | "THESIS_INVALIDATED"
  | "RECONCILIATION_BLOCKED"
  | "EXECUTION_INELIGIBLE"
  | "SYMBOL_EXPOSURE"
  | "NET_EXPOSURE"
  | "CORRELATED_EXPOSURE"
  | "SIZING_INVALID"
  | "EXECUTION_COSTS";

export interface RevalidationCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface RevalidationResult {
  ok: boolean;
  code?: BlockCode;
  reason?: string;
  /** Every check that ran, pass or fail — shown to the user, not just the first failure. */
  checks: RevalidationCheck[];
  /** Live price at the moment of the check, when one was obtainable. */
  currentPrice?: number;
}

/**
 * How far the market may move from the plan's entry before approval is
 * refused, as a fraction of the plan's own risk distance (entry → stop).
 *
 * Expressed in R rather than percent deliberately: a 0.3% drift is trivial for
 * a wide swing stop and most of the risk budget for a tight scalp. Tying the
 * tolerance to the plan's own geometry makes it mean the same thing for both.
 */
export const MAX_ENTRY_DRIFT_R = 0.25;

export const MAX_APPROVAL_MARKET_DATA_AGE_MS = 60_000;

export interface ApprovalSafetyContext {
  planFingerprintMatches: boolean;
  decisionBundleFingerprintMatches: boolean;
  tradingMode: string;
  boundExecutionTarget: "demo" | "live";
  currentExecutionTarget: "demo" | "live";
  reconciliationHealthy: boolean;
  reconciliationDetail: string;
  executionEligible: boolean;
  executionEligibilityDetail: string;
  marketDataTimestamp?: Date;
  marketStateFresh: boolean;
  marketStateHealthy: boolean;
  proposalRegime: string;
  currentRegime?: string;
  thesisValid: boolean;
  thesisDetail: string;
  symbolExposureAfterUsdt: number;
  maxSymbolExposureUsdt: number;
  netExposureAfterUsdt: number;
  maxNetExposureUsdt: number;
  correlatedExposureAfterUsdt: number;
  maxCorrelatedExposureUsdt: number;
  correlationKnownOrAllowed: boolean;
  sizingValid: boolean;
  sizingDetail: string;
  executionCostViable: boolean;
  executionCostDetail: string;
}

export interface RevalidationInputs {
  plan: {
    symbol: string;
    side: string;
    strategyId: string;
    entryPrice: number;
    slPrice: number;
    qty: number;
  };
  expiresAt: Date;
  status: string;
  now: Date;
  /** Live price, or undefined when unobtainable (approval then fails closed). */
  currentPrice?: number;
  engineRunning: boolean;
  circuitBreakerActive: boolean;
  riskPaused: boolean;
  openPositions: number;
  maxOpenPositions: number;
  /** Open positions belonging to this plan's strategy. */
  strategyOpenCount: number;
  maxConcurrentPerStrategy: number;
  /** Summed dollar risk of currently-open positions. */
  openRiskUsdt: number;
  maxPortfolioRiskUsdt: number;
  onCooldown: boolean;
  blacklisted: boolean;
  /** A position already open on this symbol. */
  symbolAlreadyOpen: boolean;
  safety: ApprovalSafetyContext;
}

/**
 * Pure — no DB, no exchange. The caller gathers current state; this decides.
 * Keeping it pure is what makes every branch testable, which matters because
 * these are the checks standing between a stale plan and real money.
 */
export function revalidate(input: RevalidationInputs): RevalidationResult {
  const checks: RevalidationCheck[] = [];
  let firstFailure: { code: BlockCode; reason: string } | null = null;

  const check = (name: string, passed: boolean, detail: string, code: BlockCode, reason: string,
  ) => {
    checks.push({ name, passed, detail });
    if (!passed && !firstFailure) firstFailure = { code, reason };
  };

  check(
    "Actionable", input.status === "created",
    input.status === "created" ? "Awaiting your decision" : `Already ${input.status}`,
    "NOT_ACTIONABLE", `This recommendation is already ${input.status} and cannot be executed`,
  );

  check(
    "Immutable plan",
    input.safety.planFingerprintMatches,
    input.safety.planFingerprintMatches
      ? "Plan fingerprint matches the frozen proposal"
      : "Stored plan no longer matches its fingerprint",
    "PLAN_MUTATED",
    "The stored plan differs from the immutable plan that was proposed",
  );
  check(
    "Immutable decision bundle",
    input.safety.decisionBundleFingerprintMatches,
    input.safety.decisionBundleFingerprintMatches
      ? "Decision bundle fingerprint verified"
      : "Decision bundle no longer matches its fingerprint",
    "DECISION_BUNDLE_MUTATED",
    "The proposal's decision/evidence bundle failed its integrity check",
  );
  check(
    "Co-Pilot authority",
    input.safety.tradingMode === "copilot",
    `Current trading mode: ${input.safety.tradingMode}`,
    "WRONG_MODE",
    "Approval is allowed only while this section remains in Co-Pilot mode",
  );
  check(
    "Execution target unchanged",
    input.safety.currentExecutionTarget === input.safety.boundExecutionTarget,
    `Proposed for ${input.safety.boundExecutionTarget}; current target ${input.safety.currentExecutionTarget}`,
    "TARGET_CHANGED",
    "The execution target changed after proposal creation; create a new proposal for the new target",
  );

  const expired = input.now.getTime() >= input.expiresAt.getTime();
  check(
    "Not expired", !expired,
    expired
      ? `Expired at ${input.expiresAt.toISOString().slice(11, 19)} UTC`
      : `Valid until ${input.expiresAt.toISOString().slice(11, 19)} UTC`,
    "EXPIRED", "This plan has expired — the setup it described is no longer current",
  );

  check(
    "Engine running", input.engineRunning,
    input.engineRunning ? "Engine is running" : "Engine is stopped",
    "ENGINE_STOPPED", "The engine is stopped — start it before executing a recommendation",
  );

  const marketDataAge = input.safety.marketDataTimestamp
    ? input.now.getTime() - input.safety.marketDataTimestamp.getTime()
    : Number.POSITIVE_INFINITY;
  const marketDataFresh =
    Number.isFinite(marketDataAge) &&
    marketDataAge >= 0 &&
    marketDataAge <= MAX_APPROVAL_MARKET_DATA_AGE_MS;
  check(
    "Market data fresh",
    marketDataFresh,
    marketDataFresh
      ? `Latest market data is ${Math.round(marketDataAge / 1000)}s old`
      : "Current market data is missing, future-dated, or stale",
    "MARKET_DATA_STALE",
    "Current market data is not fresh enough to authorize execution",
  );
  const marketStateValid =
    input.safety.marketStateFresh && input.safety.marketStateHealthy;
  check(
    "Market state healthy",
    marketStateValid,
    marketStateValid
      ? "Current MarketState is fresh and healthy"
      : "Current MarketState is stale, degraded, or unavailable",
    "MARKET_STATE_INVALID",
    "Current MarketState is not reliable enough to approve this proposal",
  );
  const regimeCompatible =
    input.safety.currentRegime === input.safety.proposalRegime;
  check(
    "Market regime unchanged",
    regimeCompatible,
    `Proposed in ${input.safety.proposalRegime}; current regime ${input.safety.currentRegime ?? "unavailable"}`,
    "THESIS_INVALIDATED",
    "The market regime changed; this is no longer the thesis that was proposed",
  );
  check(
    "Thesis remains valid",
    input.safety.thesisValid,
    input.safety.thesisDetail,
    "THESIS_INVALIDATED",
    "Current market conditions invalidate the proposal thesis",
  );

  check(
    "Circuit breaker", !input.circuitBreakerActive,
    input.circuitBreakerActive ? "Daily loss limit reached" : "Within daily loss limit",
    "CIRCUIT_BREAKER", "The daily-loss circuit breaker has tripped since this plan was created",
  );

  check(
    "Risk pause", !input.riskPaused,
    input.riskPaused ? "Trading paused after consecutive risk violations" : "Not paused",
    "RISK_PAUSED", "Trading is paused after repeated risk violations",
  );
  check(
    "Reconciliation",
    input.safety.reconciliationHealthy,
    input.safety.reconciliationDetail,
    "RECONCILIATION_BLOCKED",
    "Broker, database, or protection reconciliation does not currently permit a new entry",
  );
  check(
    "Execution eligibility",
    input.safety.executionEligible,
    input.safety.executionEligibilityDetail,
    "EXECUTION_INELIGIBLE",
    "The existing controlled executor is not currently eligible to accept this proposal",
  );

  const maxPosReached = input.openPositions >= input.maxOpenPositions;
  check(
    "Max open positions", !maxPosReached,
    `${input.openPositions}/${input.maxOpenPositions} positions open`,
    "MAX_POSITIONS", "The maximum number of open positions has been reached since this plan was created",
  );

  const stratFull = input.strategyOpenCount >= input.maxConcurrentPerStrategy;
  check(
    "Strategy concurrency", !stratFull,
    `${input.strategyOpenCount}/${input.maxConcurrentPerStrategy} open for ${input.plan.strategyId}`,
    "STRATEGY_CONCURRENCY", `${input.plan.strategyId} already holds its maximum concurrent positions`,
  );

  check(
    "Symbol not already open", !input.symbolAlreadyOpen,
    input.symbolAlreadyOpen ? `A position is already open on ${input.plan.symbol}` : "No open position on this symbol",
    "ALREADY_OPEN", `A position is already open on ${input.plan.symbol}`,
  );

  check(
    "Cooldown", !input.onCooldown,
    input.onCooldown ? "Symbol is on cooldown after a recent close" : "Not on cooldown",
    "SYMBOL_COOLDOWN", `${input.plan.symbol} is on cooldown after a recent trade`,
  );

  check(
    "Blacklist", !input.blacklisted,
    input.blacklisted ? "Symbol blacklisted after recent losses" : "Not blacklisted",
    "BLACKLISTED", `${input.plan.symbol} has been blacklisted since this plan was created`,
  );

  const candidateRisk = Math.abs(input.plan.entryPrice - input.plan.slPrice) * input.plan.qty;
  const totalRisk = input.openRiskUsdt + candidateRisk;
  const portfolioOk = totalRisk <= input.maxPortfolioRiskUsdt;
  check(
    "Portfolio risk", portfolioOk,
    `$${totalRisk.toFixed(2)} / $${input.maxPortfolioRiskUsdt.toFixed(2)} max`,
    "PORTFOLIO_RISK", "Taking this trade would exceed the portfolio risk cap",
  );
  const symbolExposureOk =
    input.safety.symbolExposureAfterUsdt <= input.safety.maxSymbolExposureUsdt;
  check(
    "Symbol exposure",
    symbolExposureOk,
    `$${input.safety.symbolExposureAfterUsdt.toFixed(2)} / $${input.safety.maxSymbolExposureUsdt.toFixed(2)} max`,
    "SYMBOL_EXPOSURE",
    "Taking this trade would exceed the current symbol exposure limit",
  );
  const netExposureOk =
    input.safety.netExposureAfterUsdt <= input.safety.maxNetExposureUsdt;
  check(
    "Net exposure",
    netExposureOk,
    `$${input.safety.netExposureAfterUsdt.toFixed(2)} / $${input.safety.maxNetExposureUsdt.toFixed(2)} max`,
    "NET_EXPOSURE",
    "Taking this trade would exceed the current net exposure limit",
  );
  const correlatedExposureOk =
    input.safety.correlationKnownOrAllowed &&
    input.safety.correlatedExposureAfterUsdt <=
      input.safety.maxCorrelatedExposureUsdt;
  check(
    "Correlated exposure",
    correlatedExposureOk,
    `$${input.safety.correlatedExposureAfterUsdt.toFixed(2)} / $${input.safety.maxCorrelatedExposureUsdt.toFixed(2)} max`,
    "CORRELATED_EXPOSURE",
    "Current correlation or cluster exposure does not permit this trade",
  );
  check(
    "Sizing and geometry",
    input.safety.sizingValid,
    input.safety.sizingDetail,
    "SIZING_INVALID",
    "Current deterministic sizing constraints reject this proposal",
  );
  check(
    "Execution costs",
    input.safety.executionCostViable,
    input.safety.executionCostDetail,
    "EXECUTION_COSTS",
    "Current fees and slippage no longer leave a viable target after costs",
  );

  // Price drift, measured in the plan's own R units.
  if (input.currentPrice !== undefined && input.currentPrice > 0) {
    const riskDistance = Math.abs(input.plan.entryPrice - input.plan.slPrice);
    const drift = Math.abs(input.currentPrice - input.plan.entryPrice);
    const driftR = riskDistance > 0 ? drift / riskDistance : 0;
    const driftOk = driftR <= MAX_ENTRY_DRIFT_R;
    check(
      "Price still near the plan", driftOk,
      `Now ${input.currentPrice} vs planned ${input.plan.entryPrice} (${driftR.toFixed(2)}R of ${MAX_ENTRY_DRIFT_R}R allowed)`,
      "PRICE_DRIFT",
      `The market has moved ${driftR.toFixed(2)}R away from the planned entry — this is no longer the trade that was analysed`,
    );
  } else {
    check(
      "Price still near the plan", false,
      "Live price unavailable — approval cannot verify entry drift",
      "PRICE_UNAVAILABLE",
      "A current live price could not be obtained, so the approved entry cannot be verified safely",
    );
  }

  const failure = firstFailure as { code: BlockCode; reason: string } | null;
  if (failure) {
    return { ok: false, code: failure.code, reason: failure.reason, checks, ...(input.currentPrice !== undefined && { currentPrice: input.currentPrice,
      }),
    };
  }
  return { ok: true, checks, ...(input.currentPrice !== undefined && { currentPrice: input.currentPrice,
    }),
  };
}
