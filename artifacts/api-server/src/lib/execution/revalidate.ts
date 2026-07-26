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
  | "PRICE_DRIFT"
  | "CIRCUIT_BREAKER"
  | "RISK_PAUSED"
  | "MAX_POSITIONS"
  | "STRATEGY_CONCURRENCY"
  | "PORTFOLIO_RISK"
  | "SYMBOL_COOLDOWN"
  | "BLACKLISTED"
  | "ALREADY_OPEN"
  | "ENGINE_STOPPED";

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
  /** Live price, or undefined when unobtainable (then drift cannot be checked). */
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
}

/**
 * Pure — no DB, no exchange. The caller gathers current state; this decides.
 * Keeping it pure is what makes every branch testable, which matters because
 * these are the checks standing between a stale plan and real money.
 */
export function revalidate(input: RevalidationInputs): RevalidationResult {
  const checks: RevalidationCheck[] = [];
  let firstFailure: { code: BlockCode; reason: string } | null = null;

  const check = (name: string, passed: boolean, detail: string, code: BlockCode, reason: string) => {
    checks.push({ name, passed, detail });
    if (!passed && !firstFailure) firstFailure = { code, reason };
  };

  check(
    "Actionable", input.status === "created",
    input.status === "created" ? "Awaiting your decision" : `Already ${input.status}`,
    "NOT_ACTIONABLE", `This recommendation is already ${input.status} and cannot be executed`,
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
    checks.push({
      name: "Price still near the plan",
      passed: true,
      detail: "Live price unavailable — drift not checked",
    });
  }

  const failure = firstFailure as { code: BlockCode; reason: string } | null;
  if (failure) {
    return { ok: false, code: failure.code, reason: failure.reason, checks, ...(input.currentPrice !== undefined && { currentPrice: input.currentPrice }) };
  }
  return { ok: true, checks, ...(input.currentPrice !== undefined && { currentPrice: input.currentPrice }) };
}
