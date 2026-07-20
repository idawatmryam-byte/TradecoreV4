/**
 * TradeCore Pro — Strategy Framework Base Types  (Phase 2)
 *
 * Every strategy implements the Strategy interface and returns a StrategySignal.
 * Shared indicators (SignalRow) are computed once per symbol per scan tick and
 * passed to every strategy's evaluate() — no duplicate candle processing.
 */
import type { MultiTimeframeCandles, SignalRow, MarketRegime } from "../strategy";
import type { RiskCheck } from "../decisionTrace";
import type { DollarRiskConfig } from "../dollarRisk";

// ─────────────────────────────────────────────────────────────────────────────
// Per-strategy configurable parameters (stored in DB)
// ─────────────────────────────────────────────────────────────────────────────
export interface StrategyConfig {
  strategyId: string;
  enabled: boolean;

  // ── Dollar trade plan (primary UI controls) ──────────────────────────────
  // When maxLossUsdt AND targetProfitUsdt are set (> 0), this strategy trades
  // the dollar risk model: SL/TP prices and size derive from these numbers
  // (lib/dollarRisk.ts), overriding the %-based fields below. null = legacy.
  /** Spot: notional per trade. Futures: MARGIN per trade. null → global positionSizeUsdt. */
  tradeAmountUsdt: number | null;
  /** Max dollars to lose on one trade (net of fees). */
  maxLossUsdt: number | null;
  /** Desired dollar profit for one trade (net of fees). */
  targetProfitUsdt: number | null;

  /** % of account balance to risk per trade */
  riskPercent: number;
  /** Minimum confidence score to enter (0–100) */
  confidenceThreshold: number;
  /** Stop-loss distance as a % below entry price (Phase 5A — replaces ATR multiplier) */
  stopLossPercent: number;
  /** Take-profit distance as a % above entry price (Phase 5A — replaces ATR multiplier) */
  takeProfitPercent: number;
  /** Maximum seconds to hold a position before forced exit */
  maxHoldingSeconds: number;
  /** Max concurrent open positions for this strategy */
  maxConcurrentPositions: number;
  /** Cooldown minutes after an exit before re-entering the same symbol */
  cooldownMinutes: number;

  // ── Phase 4B: professional trade management ────────────────────────────
  /** Pre-TP1 break-even arm: at this many R of unrealized profit the stop
   *  moves to entry even before TP1 fills — the trade can no longer lose.
   *  0 disables (break-even then arms only when TP1 fills). */
  breakEvenRMultiple: number;
  /** R-multiple at which TP1 partial-closes. 0 disables TP1/BE/trailing (single-TP behavior). */
  tp1RMultiple: number;
  /** % of the original position closed at TP1 (1-99). */
  tp1ClosePercent: number;
  /** If true, uses a 3-level scale-out (TP1 → TP2 partial → TP3 final). If false, TP1 → existing takeProfitPercent-derived takeProfit (final). */
  tp3Enabled: boolean;
  tp2RMultiple: number;
  tp2ClosePercent: number;
  tp3RMultiple: number;
  /** "none" | "atr" | "percent" | "dynamic" */
  trailingStopMode: "none" | "atr" | "percent" | "dynamic";
  trailingStopAtrMultiplier: number;
  trailingStopPercent: number;
  trailingAfterTp1Only: boolean;
  /** R-multiple of unrealized profit that arms emergency trailing even before TP1. 0 disables. */
  emergencyTrailingRMultiple: number;
  emergencyTrailingPercent: number;
  /** Ordered subset of stop_loss,take_profit,trailing_stop,timeout — see TradeManager. */
  exitPriority: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Futures Phase: long/short direction. Spot is long-only (side "buy" always);
// futures can be either. This is the semantic type strategies/exit logic work
// in — it maps to the DB's `side` column ("buy"/"sell", the actual order
// side used to open) at the entry/persistence boundary: long → "buy",
// short → "sell". See lib/db/src/schema/trades.ts's `side` column comment.
// ─────────────────────────────────────────────────────────────────────────────
export type PositionSide = "long" | "short";

// ─────────────────────────────────────────────────────────────────────────────
// Output of a strategy evaluation
// ─────────────────────────────────────────────────────────────────────────────
export interface StrategySignal {
  strategyId: string;
  strategyName: string;
  symbol: string;
  /** Long (buy-to-open) or short (sell-to-open, futures only). */
  side: PositionSide;
  /** Confidence 0–100, strategy-specific calculation */
  confidence: number;
  /** Human-readable entry rationale for logging / UI */
  entryReason: string;
  /** Regime at the time of the signal */
  regime: MarketRegime;
  entryPrice: number;
  suggestedSL: number;
  suggestedTP: number;
  /** Expected holding duration in seconds */
  suggestedHoldingTime: number;
  /** Pre-computed quantity (units of base asset) */
  qty: number;
  /** Net reward:risk after round-trip costs, populated centrally by the
   *  StrategySelector (see tradingCosts.netRewardRisk) so every accepted
   *  signal carries the auditable number the entry decision was made on. */
  netRewardRisk?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Professional decision-making model ("the brains")
//
// A strategy that implements decide() owns the COMPLETE trade decision: it
// reads the market itself, chooses entry, stop, target, leverage, size and
// expected duration, writes down its reasoning, and approves or rejects its
// own trade. The engines (live + backtest) execute approved TradePlans and
// enforce only physical invariants (margin, exchange minimums, liquidation
// buffer). Strategies without decide() run through the legacy adapter in
// selector.ts, which reproduces the historical evaluate()-based behavior
// byte-for-byte (verified by the harness Δ0 gate).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The full written justification for a decision — what a professional trader
 * would put in their journal BEFORE the trade. Rendered in the Decisions feed
 * and stored on the trade row for the post-trade post-mortem.
 */
export interface DecisionReport {
  /** One-paragraph human-readable verdict (doubles as the entry reason). */
  summary: string;
  /** Observed market facts: S/R levels, volatility, momentum, volume… */
  marketView: string[];
  /** Why enter (and why now). */
  entryLogic: string[];
  /** Why this stop / this leverage / this size. */
  riskLogic: string[];
  /** Why this target / this expected duration. */
  exitLogic: string[];
  /** Named checks with pass/fail — same shape the dashboard pipeline uses. */
  checks: RiskCheck[];
  /** Structured numbers the post-mortem compares against actual outcomes. */
  data?: Record<string, unknown>;
}

/**
 * A complete, self-contained trade decision. Everything the execution layer
 * needs — nothing is derived downstream except re-anchoring SL/TP distances
 * to the actual fill price.
 */
export interface TradePlan {
  strategyId: string;
  strategyName: string;
  symbol: string;
  side: PositionSide;
  /** Final strategy-owned confidence 0–100 (legacy path: post-unify blend). */
  confidence: number;
  entryPrice: number;
  slPrice: number;
  tpPrice: number;
  /** Base-asset quantity. */
  qty: number;
  /** Strategy-chosen leverage, already ≤ the user's leverage cap. 1 = spot/no leverage. */
  leverage: number;
  /** How long the thesis realistically needs (the ~20min–2h intraday window). */
  expectedHoldSeconds: number;
  /** Hard engine timeout — the forced-exit deadline. */
  maxHoldSeconds: number;
  regime: MarketRegime;
  /** Net reward:risk after costs — stamped centrally by the dispatcher. */
  netRewardRisk?: number;
  report: DecisionReport;
}

/** Where in its own decision process a strategy said no. */
export type RejectionStage =
  | "setup"        // conditions never formed a tradeable setup worth reporting
  | "dollar-plan"  // dollar risk not placeable (fees ≥ max loss, unsafe stop…)
  | "coin-fit"     // stop inside noise band / target unreachable on this coin
  | "leverage"     // no leverage ≥1 satisfies risk + noise floor + liquidation
  | "reward-risk"  // net reward:risk below the structural floor
  | "sizing";      // quantity degenerate (zero/below exchange minimum)

/** A considered-and-rejected trade, with the reasoning — first-class output. */
export interface TradeRejection {
  strategyId: string;
  strategyName: string;
  symbol: string;
  side?: PositionSide;
  stage: RejectionStage;
  reason: string;
  confidence?: number;
  report?: DecisionReport;
}

/**
 * decide() outcome. `null` means "no setup at all" (wrong regime, quiet
 * market) — too common to record. A rejection means the strategy genuinely
 * considered a trade and said no for a stated reason — that IS recorded.
 */
export type TradeDecision =
  | { kind: "plan"; plan: TradePlan }
  | { kind: "rejection"; rejection: TradeRejection };

/**
 * Account-level facts a deciding strategy needs. Pure data — the trader
 * toolkit (strategies/toolkit.ts) is imported directly by strategies since
 * its helpers are pure functions.
 */
export interface DecisionContext {
  balance: number;
  /** Legacy notional cap (already ×leverage where callers apply it). */
  positionSizeUsdt: number;
  marketType: "spot" | "futures";
  /** User's account leverage setting — a HARD CAP the strategy never exceeds. */
  leverageCap: number;
  /** Taker fee fraction per leg for this market. */
  feeRate: number;
  /** Slippage fraction per leg for this market (crypto 0.05%, forex 0.005%). */
  slippageRate: number;
  /**
   * Resolved dollar plan for THIS strategy (per-strategy plan → global dollar
   * config → null = legacy %). Its `leverage` field equals leverageCap; the
   * strategy may plan a LOWER leverage via the solver.
   */
  dollarPlan: DollarRiskConfig | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Strategy interface — every strategy must implement this
// ─────────────────────────────────────────────────────────────────────────────
export interface Strategy {
  readonly strategyId: string;
  readonly strategyName: string;
  /** Regimes in which this strategy is active */
  readonly supportedRegimes: ReadonlyArray<MarketRegime>;
  /** The indicators this strategy reads, human-readable with timeframe —
   *  shown on the Strategies page so users see exactly what each brain
   *  watches (e.g. "MACD histogram (3m)"). */
  readonly indicators: ReadonlyArray<string>;

  /**
   * Professional decision-maker ("the brain"). When implemented, this fully
   * replaces the evaluate()+selector pipeline for this strategy: the return
   * value is a complete TradePlan (or a reasoned rejection / null for no
   * setup). The dispatcher still applies the central net-reward:risk floor —
   * a cost-viability invariant, not trading judgment.
   */
  decide?(
    symbol: string,
    mtf: MultiTimeframeCandles,
    row: SignalRow,
    config: StrategyConfig,
    ctx: DecisionContext,
  ): TradeDecision | null;

  /**
   * Evaluate a symbol given pre-computed shared indicators.
   * Returns null if conditions are not met, or a StrategySignal on success.
   *
   * @param symbol            Trading pair, e.g. "BTCUSDT"
   * @param mtf               Raw candle arrays for all timeframes
   * @param row               Pre-computed SignalRow from buildSignalRow()
   * @param config            Per-strategy runtime parameters from DB
   * @param balance           Current account balance (USDT) for position sizing
   * @param positionSizeUsdt  Hard cap on position size (USDT)
   */
  evaluate(
    symbol: string,
    mtf: MultiTimeframeCandles,
    row: SignalRow,
    config: StrategyConfig,
    balance: number,
    positionSizeUsdt: number,
  ): StrategySignal | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Default config per strategy ID (used when DB has no row yet)
// ─────────────────────────────────────────────────────────────────────────────
export const DEFAULT_STRATEGY_CONFIGS: Record<string, Omit<StrategyConfig, "strategyId">> = {
  momentum_breakout: {
    enabled: true,
    // Native decide() pilot: trades the dollar risk model. The 2:1 target
    // mirrors its historical 1.5%-stop/3%-target %-profile. Users can change
    // all three on the Strategies page — these are only the fresh-install
    // defaults; without a plan the strategy rejects (with the reason shown
    // in the Decisions feed) instead of trading.
    tradeAmountUsdt: 300, maxLossUsdt: 40, targetProfitUsdt: 80,
    riskPercent: 1.0,
    confidenceThreshold: 70,
    stopLossPercent: 1.5,
    takeProfitPercent: 3.0,
    maxHoldingSeconds: 3600,
    maxConcurrentPositions: 2,
    cooldownMinutes: 30,
    breakEvenRMultiple: 0.7,
    tp1RMultiple: 1.0, tp1ClosePercent: 50,
    tp3Enabled: false, tp2RMultiple: 2.0, tp2ClosePercent: 25, tp3RMultiple: 4.0,
    trailingStopMode: "atr", trailingStopAtrMultiplier: 1.5, trailingStopPercent: 1.0,
    trailingAfterTp1Only: true,
    emergencyTrailingRMultiple: 3.0, emergencyTrailingPercent: 0.5,
    exitPriority: ["stop_loss", "take_profit", "trailing_stop", "timeout"],
  },
  trend_pullback: {
    enabled: true,
    tradeAmountUsdt: null, maxLossUsdt: null, targetProfitUsdt: null,
    riskPercent: 1.2,
    confidenceThreshold: 65,
    stopLossPercent: 1.5,
    takeProfitPercent: 2.5,
    maxHoldingSeconds: 7200,
    maxConcurrentPositions: 3,
    cooldownMinutes: 20,
    // Trend-following: let winners run further — 3-level scale-out with a wide final target.
    breakEvenRMultiple: 0,
    tp1RMultiple: 1.0, tp1ClosePercent: 40,
    tp3Enabled: true, tp2RMultiple: 2.0, tp2ClosePercent: 30, tp3RMultiple: 5.0,
    trailingStopMode: "dynamic", trailingStopAtrMultiplier: 2.0, trailingStopPercent: 1.5,
    trailingAfterTp1Only: true,
    emergencyTrailingRMultiple: 4.0, emergencyTrailingPercent: 0.75,
    exitPriority: ["stop_loss", "take_profit", "trailing_stop", "timeout"],
  },
  mean_reversion: {
    enabled: true,
    tradeAmountUsdt: null, maxLossUsdt: null, targetProfitUsdt: null,
    riskPercent: 0.8,
    confidenceThreshold: 60,
    stopLossPercent: 1.0,
    takeProfitPercent: 1.5,
    maxHoldingSeconds: 1800,
    maxConcurrentPositions: 2,
    cooldownMinutes: 15,
    // Mean-reversion targets are already tight — a single TP is usually enough,
    // but a small TP1 locks in something if price stalls halfway to target.
    breakEvenRMultiple: 0,
    tp1RMultiple: 0.7, tp1ClosePercent: 60,
    tp3Enabled: false, tp2RMultiple: 1.5, tp2ClosePercent: 20, tp3RMultiple: 2.5,
    trailingStopMode: "percent", trailingStopAtrMultiplier: 1.0, trailingStopPercent: 0.6,
    trailingAfterTp1Only: true,
    emergencyTrailingRMultiple: 2.0, emergencyTrailingPercent: 0.4,
    exitPriority: ["stop_loss", "take_profit", "trailing_stop", "timeout"],
  },
  vwap_reversion: {
    enabled: true,
    tradeAmountUsdt: null, maxLossUsdt: null, targetProfitUsdt: null,
    riskPercent: 0.75,
    confidenceThreshold: 60,
    stopLossPercent: 1.2,
    takeProfitPercent: 1.8,
    maxHoldingSeconds: 1800,
    maxConcurrentPositions: 2,
    cooldownMinutes: 15,
    breakEvenRMultiple: 0,
    tp1RMultiple: 0.8, tp1ClosePercent: 55,
    tp3Enabled: false, tp2RMultiple: 1.5, tp2ClosePercent: 20, tp3RMultiple: 2.5,
    trailingStopMode: "percent", trailingStopAtrMultiplier: 1.0, trailingStopPercent: 0.6,
    trailingAfterTp1Only: true,
    emergencyTrailingRMultiple: 2.0, emergencyTrailingPercent: 0.4,
    exitPriority: ["stop_loss", "take_profit", "trailing_stop", "timeout"],
  },
  micro_scalping: {
    enabled: true,
    tradeAmountUsdt: null, maxLossUsdt: null, targetProfitUsdt: null,
    riskPercent: 0.5,
    confidenceThreshold: 65,
    stopLossPercent: 0.8,
    takeProfitPercent: 1.2,
    maxHoldingSeconds: 600,
    maxConcurrentPositions: 2,
    cooldownMinutes: 10,
    // Scalping: hold time is already seconds-scale — TP1 disabled by default
    // (tp1RMultiple 0) since the full target is usually reached or timed out
    // before a partial makes sense; can be enabled per-user via the config UI.
    breakEvenRMultiple: 0,
    tp1RMultiple: 0, tp1ClosePercent: 50,
    tp3Enabled: false, tp2RMultiple: 1.5, tp2ClosePercent: 20, tp3RMultiple: 2.0,
    trailingStopMode: "none", trailingStopAtrMultiplier: 0.8, trailingStopPercent: 0.3,
    trailingAfterTp1Only: true,
    emergencyTrailingRMultiple: 0, emergencyTrailingPercent: 0.25,
    exitPriority: ["stop_loss", "take_profit", "timeout"],
  },
  scalp_reversion: {
    // OFF by default — this is an intraday-scalping EXPERIMENT. Enable it (and
    // optionally disable the swing strategies) to test the scalping thesis in
    // isolation. 1:2 R:R, tight stop, ~15-min max hold, fast re-entry, pure
    // SL/TP/timeout exits (no TP1/trailing) so the raw signal is easy to read.
    // Pair with maker entries in the backtest for realistic scalper fees.
    enabled: false,
    tradeAmountUsdt: null, maxLossUsdt: null, targetProfitUsdt: null,
    riskPercent: 1.0,
    confidenceThreshold: 50,
    stopLossPercent: 0.35,
    takeProfitPercent: 0.7, // 1:2 R:R (adaptive cap preserves the ratio)
    maxHoldingSeconds: 900, // 15-minute time-stop
    maxConcurrentPositions: 4,
    cooldownMinutes: 2, // scalping re-enters quickly
    breakEvenRMultiple: 0,
    tp1RMultiple: 0, tp1ClosePercent: 50,
    tp3Enabled: false, tp2RMultiple: 1.5, tp2ClosePercent: 20, tp3RMultiple: 2.0,
    trailingStopMode: "none", trailingStopAtrMultiplier: 0.5, trailingStopPercent: 0.2,
    trailingAfterTp1Only: true,
    emergencyTrailingRMultiple: 0, emergencyTrailingPercent: 0.2,
    exitPriority: ["stop_loss", "take_profit", "timeout"],
  },
  volatility_breakout: {
    enabled: true,
    tradeAmountUsdt: null, maxLossUsdt: null, targetProfitUsdt: null,
    riskPercent: 1.0,
    confidenceThreshold: 68,
    stopLossPercent: 1.5,
    takeProfitPercent: 2.5,
    maxHoldingSeconds: 3600,
    maxConcurrentPositions: 2,
    cooldownMinutes: 30,
    breakEvenRMultiple: 0,
    tp1RMultiple: 1.0, tp1ClosePercent: 50,
    tp3Enabled: false, tp2RMultiple: 2.0, tp2ClosePercent: 25, tp3RMultiple: 4.0,
    trailingStopMode: "atr", trailingStopAtrMultiplier: 1.75, trailingStopPercent: 1.2,
    trailingAfterTp1Only: true,
    emergencyTrailingRMultiple: 3.0, emergencyTrailingPercent: 0.5,
    exitPriority: ["stop_loss", "take_profit", "trailing_stop", "timeout"],
  },
  twenty_min_momentum: {
    // OFF by default — a fast futures scalper. Ships with a dollar trade plan
    // sized for a true 20-minute window: on $300 margin × 50× (= $15k notional)
    // a $45 target is a ~0.4% move, which crypto reaches inside 20 min; the
    // per-coin fit check then keeps only coins actually moving that fast. Raise
    // Target to $75 and it becomes a ~1-hour trade (a 0.6% move) — tune both on
    // the Strategies card. Requires the account on Futures + leverage + isolated.
    enabled: false,
    tradeAmountUsdt: 300, maxLossUsdt: 50, targetProfitUsdt: 45,
    riskPercent: 1.0,
    confidenceThreshold: 55,
    stopLossPercent: 0.4,   // legacy fallback (used only if the dollar plan is cleared)
    takeProfitPercent: 0.6,
    maxHoldingSeconds: 1200, // 20-minute time-stop — the whole point
    maxConcurrentPositions: 3,
    cooldownMinutes: 3,
    // Two-stage exit (pro-brain behavior, observed live): the final target can
    // sit ~1% away while the market backs off halfway — a single far TP turns
    // those into timeouts/losses. TP1 banks HALF the position at +1R and moves
    // the stop to break-even (a reversal after progress keeps its profit); the
    // remainder rides toward the full target with a tight ATR trail.
    breakEvenRMultiple: 0.7,
    tp1RMultiple: 1.0, tp1ClosePercent: 50,
    tp3Enabled: false, tp2RMultiple: 1.5, tp2ClosePercent: 20, tp3RMultiple: 2.0,
    trailingStopMode: "atr", trailingStopAtrMultiplier: 1.0, trailingStopPercent: 0.3,
    trailingAfterTp1Only: true,
    emergencyTrailingRMultiple: 0, emergencyTrailingPercent: 0.3,
    exitPriority: ["stop_loss", "take_profit", "trailing_stop", "timeout"],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Percentage-based Stop Loss / Take Profit  (Phase 5A)
//
// Single source of truth for where every strategy's protective exits sit.
// SL/TP are now a fixed % distance from the entry price — never derived from
// ATR, Bollinger Band width, VWAP, or any other volatility/level-based
// measure. Those indicators may still gate ENTRIES (regime detection,
// squeeze detection, pullback zones, confidence scoring) — they must never
// feed into where SL/TP is placed. Every strategy's evaluate() calls this
// same function so Live Trading and Backtesting are always exit-identical.
// ─────────────────────────────────────────────────────────────────────────────
export function computePercentSLTP(
  entryPrice: number,
  stopLossPercent: number,
  takeProfitPercent: number,
  side: PositionSide = "long",
): { slPrice: number; tpPrice: number } {
  if (side === "short") {
    // Mirror image of long: SL sits ABOVE entry (price rising hurts a short),
    // TP sits BELOW entry (price falling is the short's profit direction).
    const slPrice = entryPrice * (1 + stopLossPercent / 100);
    const tpPrice = entryPrice * (1 - takeProfitPercent / 100);
    return { slPrice, tpPrice };
  }
  const slPrice = entryPrice * (1 - stopLossPercent / 100);
  const tpPrice = entryPrice * (1 + takeProfitPercent / 100);
  return { slPrice, tpPrice };
}

// ─────────────────────────────────────────────────────────────────────────────
// Volatility-adaptive SL/TP  (data-driven fix)
//
// WHY: across 5 real-data backtests (2,237 trades; BTC/ETH/BNB/SOL/XRP, 1m),
// 87–94% of exits were TIMEOUTS and only 14 take-profits ever hit — because
// the configured %-targets were physically unreachable inside the holding
// window. Example: BTC's 1m ATR ≈ 0.05%, so a 10-minute hold typically
// ranges ~0.2%, while micro-scalping's TP sat at 1.2% — 6–8× farther than
// the market moves in that window. Trades weren't losing to bad signals;
// they timed out on random drift and bled fees (PF 0.33–0.59).
//
// FIX: treat each strategy's configured SL%/TP% as a CEILING, and scale both
// down proportionally (risk:reward ratio preserved) to what the symbol's
// measured volatility says is reachable within maxHoldingSeconds:
//     reachable% ≈ ATR%(1m) × √(holdMinutes) × TARGET_REACH_K
// (random-walk range scaling). The net reward:risk cost gate downstream then
// automatically REJECTS setups whose reachable target can't clear round-trip
// fees — the correct "no edge available at this volatility" outcome instead
// of forcing a doomed trade. Shared by live + backtest via the strategies.
// ─────────────────────────────────────────────────────────────────────────────
/** Fraction-of-typical-range a target may occupy. Tunable against real data. */
export const TARGET_REACH_K = 1.5;

export function computeAdaptiveSLTP(
  entryPrice: number,
  cfg: StrategyConfig,
  side: PositionSide,
  atrPercentPerCandle: number,
  maxHoldingSeconds: number = cfg.maxHoldingSeconds,
  candleMinutes: number = 1,
): { slPrice: number; tpPrice: number; slPercent: number; tpPercent: number; volCapped: boolean } {
  let tpPct = cfg.takeProfitPercent;
  let slPct = cfg.stopLossPercent;
  let volCapped = false;

  if (atrPercentPerCandle > 0 && maxHoldingSeconds > 0 && tpPct > 0) {
    // Number of primary candles inside the holding window; range over N
    // candles ≈ per-candle ATR% × √N. Normalizing by candleMinutes matters
    // in coarse backtests, where the primary series is 5m/15m/… candles —
    // treating their ATR as per-minute overestimated reachable moves ~√k and
    // the cap silently never engaged (live always runs true 1m).
    const holdCandles = maxHoldingSeconds / 60 / Math.max(1, candleMinutes);
    const reachablePct = atrPercentPerCandle * Math.sqrt(holdCandles) * TARGET_REACH_K;
    if (reachablePct < tpPct) {
      const scale = reachablePct / tpPct;
      tpPct = reachablePct;
      slPct = slPct * scale; // preserve the strategy's R:R character
      volCapped = true;
    }
  }

  const { slPrice, tpPrice } = computePercentSLTP(entryPrice, slPct, tpPct, side);
  return { slPrice, tpPrice, slPercent: slPct, tpPercent: tpPct, volCapped };
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility: compute position quantity from risk params
// ─────────────────────────────────────────────────────────────────────────────
export function computeQty(
  balance: number,
  riskPercent: number,
  entryPrice: number,
  slPrice: number,
  positionSizeUsdt: number,
  minNotional = 10,
  side: PositionSide = "long",
): number {
  // Hard guard: SL must be positive and on the correct side of entry for the
  // position direction — below entry for a long (price falling hurts it),
  // above entry for a short (price rising hurts it). An invalid SL (zero
  // ATR, miscalculation, etc.) always returns 0 so the strategy filter
  // rejects the signal before a trade is placed.
  if (slPrice <= 0) return 0;
  if (side === "short" ? slPrice <= entryPrice : slPrice >= entryPrice) return 0;

  if (riskPercent > 0 && balance > 0) {
    const riskAmount = balance * (riskPercent / 100);
    const stopDist   = side === "short" ? slPrice - entryPrice : entryPrice - slPrice;
    const riskQty    = riskAmount / stopDist;
    // Cap to the configured USDT hard limit. When the cap kicks in, the
    // actual loss on a stop-out is proportionally less than riskAmount —
    // a safe outcome, never more risk than intended.
    const cappedUsdt = Math.min(riskQty * entryPrice, positionSizeUsdt);
    if (cappedUsdt < minNotional) return 0;
    return cappedUsdt / entryPrice;
  }

  // Fixed-size fallback (riskPercent = 0): no balance-based sizing.
  if (positionSizeUsdt <= 0) return 0;
  const fixedQty = positionSizeUsdt / entryPrice;
  return fixedQty * entryPrice < minNotional ? 0 : fixedQty;
}

// ─────────────────────────────────────────────────────────────────────────────
// TP1 / TP2 interior-waypoint ladder  (Phase 4B logic, Phase 7 shared extraction)
//
// Extracted verbatim from botEngine.ts's enterTrade() (same formula, same
// clamping, same interior-waypoint validation) so live trading and the
// backtest simulation compute TP1/TP2 identically — this was previously
// inline in botEngine.ts only, meaning the backtest had no TP1/TP2 concept
// at all. `roundPrice`/`roundQty` let each caller apply its own precision
// rounding (live: exchange tick/lot size via ex.priceToPrecision/
// amountToPrecision; backtest: identity, matching the rest of
// backtestEngine.ts, which doesn't apply exchange precision anywhere today).
// ─────────────────────────────────────────────────────────────────────────────
export interface Tp1Tp2Ladder {
  tp1Price: number;
  tp1Qty: number;
  tp2Price: number;
  tp2Qty: number;
}

export function computeTp1Tp2Ladder(
  fillPrice: number,
  slPrice: number,
  tpPrice: number,
  filledQty: number,
  stratConfig: StrategyConfig,
  roundPrice: (p: number) => number = (p) => p,
  roundQty: (q: number) => number = (q) => q,
  side: PositionSide = "long",
): Tp1Tp2Ladder {
  const result: Tp1Tp2Ladder = { tp1Price: 0, tp1Qty: 0, tp2Price: 0, tp2Qty: 0 };
  const isShort = side === "short";
  // Risk distance is always a positive number regardless of direction — for
  // a short, slPrice sits ABOVE fillPrice, so the subtraction order flips.
  const riskDistance = isShort ? slPrice - fillPrice : fillPrice - slPrice;
  if (!(stratConfig.tp1RMultiple > 0) || riskDistance <= 0) return result;

  // Long TP1 sits ABOVE fill (toward tpPrice, which is also above fill);
  // short TP1 sits BELOW fill (toward tpPrice, which is also below fill).
  const candidateTp1 = isShort
    ? fillPrice - riskDistance * stratConfig.tp1RMultiple
    : fillPrice + riskDistance * stratConfig.tp1RMultiple;
  // TP1 must land strictly inside entry→takeProfit either direction.
  if (isShort ? candidateTp1 <= tpPrice : candidateTp1 >= tpPrice) return result;

  result.tp1Price = roundPrice(candidateTp1);
  // Clamp so TP1 (+TP2) can never consume the whole position — at least 10%
  // always remains for the final target to apply to.
  const tp1Percent = Math.min(stratConfig.tp1ClosePercent, 90);
  result.tp1Qty = roundQty(filledQty * (tp1Percent / 100));

  if (stratConfig.tp3Enabled) {
    const candidateTp2 = isShort
      ? fillPrice - riskDistance * stratConfig.tp2RMultiple
      : fillPrice + riskDistance * stratConfig.tp2RMultiple;
    const tp2Valid = isShort
      ? candidateTp2 < candidateTp1 && candidateTp2 > tpPrice
      : candidateTp2 > candidateTp1 && candidateTp2 < tpPrice;
    if (tp2Valid) {
      result.tp2Price = roundPrice(candidateTp2);
      const tp2Percent = Math.min(stratConfig.tp2ClosePercent, 90 - tp1Percent);
      result.tp2Qty = roundQty(filledQty * (tp2Percent / 100));
    }
  }

  return result;
}
