/**
 * TradeCore Pro — simulated fill model
 *
 * How a position behaves bar by bar when no real venue is involved: partial
 * take-profits, the break-even move, trailing stops, the exit decision when a
 * single bar touches more than one level, and the fee/slippage accounting that
 * turns all of it into a closed trade.
 *
 * Extracted VERBATIM from backtestEngine's simulation loop, where it had lived
 * inline for its whole life. Nothing about the arithmetic changed — the parity
 * harness (Δ0) is the proof. What changed is who can call it: the backtest and
 * the built-in Demo account now run the *same* code, so a demo fill and a
 * backtest fill cannot drift apart. That shared-ness is the point; a demo that
 * silently filled differently from the backtest would make both untrustworthy.
 *
 * Deliberately pure — no DB, no exchange, no clock. `now` is always passed in,
 * so a bar replayed from history and a bar arriving live are indistinguishable
 * from in here.
 *
 * The one thing this does NOT decide is whether to open a position. Entry is
 * the strategy's job (TradePlan), and it stays that way.
 */
import type { Candle } from "../strategy";
import type { PositionSide, StrategyConfig } from "../strategies";
import { computeTrailingStop } from "./trailing";

/** One scale-out along the way (TP1/TP2), recorded for the audit trail. */
export interface PartialExitRecord {
  reason: "tp1" | "tp2" | "phase7_reduce";
  qty: number;
  price: number;
  fees: number;
  pnl: number;
  time: Date;
}

/** A position being simulated. Mutated in place as bars arrive. */
export interface SimulatedPosition {
  symbol: string;
  side: PositionSide;
  entryPrice: number;
  /** Current stop — mutates via the break-even move and trailing. */
  slPrice: number;
  /** Final target — immutable after entry, exactly like live's `trades.takeProfit`. */
  tpPrice: number;
  /** Original planned stop before any break-even/trailing move. Every
   *  R-multiple is measured from this, matching TradeManager's use of
   *  `trades.plannedStopLoss`. */
  plannedSlPrice: number;
  /** Original full entry size — immutable. */
  qty: number;
  /** Shrinks as TP1/TP2 partials fill. What's left for the final exit. */
  remainingQty: number;
  entryTime: Date;
  confidence: number;
  /** Entry-side fee only; exit-side fees are computed per slice at close. */
  fees: number;
  slippage: number;
  /** Futures only: estimated isolated-margin liquidation price. */
  liquidationPrice?: number;
  strategyId?: string;
  strategyName?: string;
  regime?: string;
  leverage: number;
  maxHoldSeconds?: number;
  expectedHoldSeconds?: number;
  entryReason?: string;
  tradePlan?: unknown;
  /** Running maximum favourable / adverse excursion, in quote currency. */
  mfe: number;
  mae: number;
  tp1Price: number;
  tp1Qty: number;
  tp1Filled: boolean;
  tp1FillPrice?: number;
  tp1FillTime?: Date;
  tp2Price: number;
  tp2Qty: number;
  tp2Filled: boolean;
  tp2FillPrice?: number;
  tp2FillTime?: Date;
  breakEvenActive: boolean;
  trailingStopActive: boolean;
  trailingStopMode?: string;
  /** Best/reference price recorded when the current trailing stop was armed. */
  trailingStopArmedPrice?: number;
  partialExits: PartialExitRecord[];
}

/** Cost model. Identical shape live and simulated. */
export interface FillCosts {
  /** Taker fee per side, as a fraction. */
  feeRate: number;
  /** Maker fee per side — resting limit exits (TP) pay this. */
  makerFeeRate: number;
  /** Adverse price movement applied to every fill, as a fraction. */
  slippageRate: number;
}

/** One bar of market data plus the history behind it. */
export interface BarContext {
  candle: Candle;
  /**
   * Candles up to AND INCLUDING `candle`. Trailing ATR reads from this, so a
   * caller must not pass the whole series when replaying — only what had
   * happened by this bar, or the simulation sees the future.
   */
  history: Candle[];
  /** Market time of this bar. Never read from the wall clock in here. */
  now: Date;
}

/** The settled result of a position closing on this bar. */
export interface SettledExit {
  exitPrice: number;
  exitReason: string;
  /** NET of every fee across every slice. */
  pnl: number;
  grossPnl: number;
  pnlPercent: number;
  /** All-in cost: entry share + exit + partials. */
  totalFees: number;
  totalSlippage: number;
  durationSeconds: number;
  riskReward: number;
}

/**
 * Update the excursion envelope from this bar's range.
 *
 * Runs BEFORE exit evaluation, so a bar that both makes a new excursion and
 * triggers the exit still has that excursion counted.
 */
export function updateExcursion(pos: SimulatedPosition, high: number, low: number): void {
  const isShort = pos.side === "short";
  const favorableExcursion = isShort ? (pos.entryPrice - low) * pos.qty : (high - pos.entryPrice) * pos.qty;
  const adverseExcursion = isShort ? (pos.entryPrice - high) * pos.qty : (low - pos.entryPrice) * pos.qty;
  if (favorableExcursion > pos.mfe) pos.mfe = favorableExcursion;
  if (adverseExcursion < pos.mae) pos.mae = adverseExcursion;
}

/**
 * Trade management for one bar: TP1 → TP2 → break-even → trailing.
 *
 * Mirrors TradeManager.manage()'s control flow exactly — same order, same
 * conditions. Runs BEFORE the exit check so a partial fill, break-even move,
 * or trailing tighten on this same bar is reflected in that check, exactly as
 * it would be live (TradeManager runs before ExitManager each tick).
 *
 * Mutates `pos`.
 */
export function manageBar(
  pos: SimulatedPosition,
  ctx: BarContext,
  stratConfig: StrategyConfig | undefined,
  costs: FillCosts,
): void {
  if (!stratConfig || stratConfig.tp1RMultiple <= 0) return;

  const isShort = pos.side === "short";
  const [, , high, low] = ctx.candle;
  const { slippageRate, makerFeeRate } = costs;

  // A bar that reaches the existing stop cannot first bank a profitable
  // partial and move that stop out of the way. OHLC does not prove that
  // favorable ordering; preserve the original position for settlement.
  if (isShort ? high >= pos.slPrice : low <= pos.slPrice) return;

  // TP1: partial close + move stop to break-even. Long TP1 sits above entry
  // (triggered by a high); short TP1 sits below (triggered by a low).
  if (
    !pos.tp1Filled &&
    pos.tp1Price > 0 &&
    (isShort ? low <= pos.tp1Price : high >= pos.tp1Price)
  ) {
    // Worse fill = lower for a long's sell-to-exit, higher for a short's
    // buy-to-cover.
    const fillP =
      pos.tp1Price * (isShort ? 1 + slippageRate : 1 - slippageRate);
    const qty = Math.min(pos.tp1Qty, pos.remainingQty);
    if (qty > 0) {
      // Pro-rate the ACTUAL entry fee paid by this slice's share — correct
      // whether the entry was maker or taker — and charge the TP1 limit exit
      // at the maker rate.
      const entryFeeShare = pos.qty > 0 ? pos.fees * (qty / pos.qty) : 0;
      const exitFee = fillP * qty * makerFeeRate;
      const fees = entryFeeShare + exitFee;
      const pnl =
        (isShort ? pos.entryPrice - fillP : fillP - pos.entryPrice) * qty -
        fees;
      pos.partialExits.push({
        reason: "tp1",
        qty,
        price: fillP,
        fees,
        pnl,
        time: ctx.now,
      });
      pos.remainingQty -= qty;
      pos.tp1Filled = true;
      pos.tp1FillPrice = fillP;
      pos.tp1FillTime = ctx.now;
      pos.slPrice = pos.entryPrice; // break-even move
      pos.breakEvenActive = true;
    }
  }

  // TP2 (only when tp3Enabled): another slice. The remainder keeps targeting
  // the strategy's own final tpPrice — TP1/TP2 are interior waypoints, never
  // beyond it.
  if (
    stratConfig.tp3Enabled &&
    pos.tp1Filled &&
    !pos.tp2Filled &&
    pos.tp2Price > 0 &&
    (isShort ? low <= pos.tp2Price : high >= pos.tp2Price)
  ) {
    const fillP =
      pos.tp2Price * (isShort ? 1 + slippageRate : 1 - slippageRate);
    const qty = Math.min(pos.tp2Qty, pos.remainingQty);
    if (qty > 0) {
      const entryFeeShare = pos.qty > 0 ? pos.fees * (qty / pos.qty) : 0;
      const exitFee = fillP * qty * makerFeeRate;
      const fees = entryFeeShare + exitFee;
      const pnl =
        (isShort ? pos.entryPrice - fillP : fillP - pos.entryPrice) * qty -
        fees;
      pos.partialExits.push({
        reason: "tp2",
        qty,
        price: fillP,
        fees,
        pnl,
        time: ctx.now,
      });
      pos.remainingQty -= qty;
      pos.tp2Filled = true;
      pos.tp2FillPrice = fillP;
      pos.tp2FillTime = ctx.now;
      // TP2 does not move the stop further — only TP1 does (matches TradeManager).
    }
  }

  // Trailing stop (normal or emergency) — same formula as live, only ever
  // tightening (raises for a long, lowers for a short), never loosening.
  const currentClose = ctx.candle[4];
  const originalRiskDistance = isShort
    ? pos.plannedSlPrice - pos.entryPrice
    : pos.entryPrice - pos.plannedSlPrice;
  if (originalRiskDistance > 0) {
    const unrealizedR =
      (isShort
        ? pos.entryPrice - currentClose
        : currentClose - pos.entryPrice) / originalRiskDistance;
    // Pre-TP1 break-even arm — mirror of TradeManager: once unrealized profit
    // reaches breakEvenRMultiple × R, the stop moves to entry (only ever
    // tightening). The trade can no longer turn into a loss.
    if (
      stratConfig.breakEvenRMultiple > 0 &&
      !pos.breakEvenActive &&
      !pos.tp1Filled &&
      unrealizedR >= stratConfig.breakEvenRMultiple &&
      (isShort ? pos.entryPrice < pos.slPrice : pos.entryPrice > pos.slPrice)
    ) {
      pos.slPrice = pos.entryPrice;
      pos.breakEvenActive = true;
    }
    const trailingArmed = pos.tp1Filled || !stratConfig.trailingAfterTp1Only;
    const emergencyArmed =
      !trailingArmed &&
      stratConfig.emergencyTrailingRMultiple > 0 &&
      unrealizedR >= stratConfig.emergencyTrailingRMultiple;
    if (
      (trailingArmed && stratConfig.trailingStopMode !== "none") ||
      emergencyArmed
    ) {
      const mode = emergencyArmed ? "emergency" : stratConfig.trailingStopMode;
      const candidate = computeTrailingStop(
        mode,
        currentClose,
        ctx.history,
        stratConfig,
        emergencyArmed,
        isShort,
      );
      if (isShort ? candidate < pos.slPrice : candidate > pos.slPrice) {
        pos.slPrice = candidate;
        pos.trailingStopActive = true;
        pos.trailingStopMode = mode;
        pos.trailingStopArmedPrice = currentClose;
      }
    }
  }
}

/**
 * Decide whether this bar closes the position, and settle the accounting if
 * it does. Returns null while the position stays open.
 *
 * On the ambiguity that OHLC data cannot resolve: if one bar's range touches
 * both the stop and the target, there is no way to know which came first
 * without tick data. The strategy's configured `exitPriority` breaks the tie,
 * falling back to stop → target → timeout — the conservative ordering, which
 * never overstates results.
 */
export function settleBar(
  pos: SimulatedPosition,
  ctx: BarContext,
  stratConfig: StrategyConfig | undefined,
  costs: FillCosts,
): SettledExit | null {
  const isShort = pos.side === "short";
  const [, , high, low, close] = ctx.candle;
  const { feeRate, makerFeeRate, slippageRate } = costs;

  // A short's stop sits ABOVE entry (hit by a high) and target BELOW (hit by
  // a low) — mirror of long.
  const stopTouched = isShort ? high >= pos.slPrice : low <= pos.slPrice;
  const targetTouched = isShort ? low <= pos.tpPrice : high >= pos.tpPrice;
  const holdSecs = (ctx.now.getTime() - pos.entryTime.getTime()) / 1000;
  // Per-trade deadline first (the plan's own maxHoldSeconds); strategy config
  // is the fallback, exactly like live.
  const posMaxHold = pos.maxHoldSeconds && pos.maxHoldSeconds > 0
    ? pos.maxHoldSeconds
    : stratConfig?.maxHoldingSeconds;
  const timedOut = posMaxHold != null && holdSecs >= posMaxHold;
  // Stale-thesis exit — mirror of exitManager: held ≥ 2× the plan's EXPECTED
  // resolution with price within ±0.15R of entry → cut early as a timeout
  // rather than blocking capital until the hard deadline.
  let staleOut = false;
  if (!timedOut && pos.expectedHoldSeconds && pos.expectedHoldSeconds > 0 && holdSecs >= pos.expectedHoldSeconds * 2) {
    const staleRisk = Math.abs(pos.entryPrice - pos.plannedSlPrice);
    if (staleRisk > 0) {
      const uR = (isShort ? pos.entryPrice - close : close - pos.entryPrice) / staleRisk;
      staleOut = Math.abs(uR) <= 0.15;
    }
  }

  // Worse fill for the CLOSING trade: lower for a long (sells to close),
  // higher for a short (buys to close).
  const closeSlippageMult = isShort ? 1 + slippageRate : 1 - slippageRate;
  const stopLabel = pos.trailingStopActive ? "trailing_stop" : pos.breakEvenActive ? "break_even" : "stop_loss";
  type Candidate = { key: string; reason: string; exitPrice: number };
  const candidates: Candidate[] = [];
  if (stopTouched) candidates.push({ key: "stop_loss", reason: stopLabel, exitPrice: pos.slPrice * closeSlippageMult });
  if (stopTouched && pos.trailingStopActive) candidates.push({ key: "trailing_stop", reason: stopLabel, exitPrice: pos.slPrice * closeSlippageMult });
  if (targetTouched) candidates.push({ key: "take_profit", reason: "take_profit", exitPrice: pos.tpPrice * closeSlippageMult });
  if (timedOut || staleOut) candidates.push({ key: "timeout", reason: "timeout", exitPrice: close * closeSlippageMult });
  // Futures liquidation: a forced close at the liquidation price. The entry
  // guard keeps the stop INSIDE the liquidation price, so any bar reaching
  // liquidation also reached the (closer) stop — the priority list resolves
  // that co-touch to the stop, which fills first on the way there.
  // Liquidation is kept OUT of the priority list intentionally so it can
  // never pre-empt a nearer stop; it is only chosen as the sole trigger.
  if (pos.liquidationPrice !== undefined) {
    const liqTouched = isShort ? high >= pos.liquidationPrice : low <= pos.liquidationPrice;
    if (liqTouched) candidates.push({ key: "liquidation", reason: "liquidation", exitPrice: pos.liquidationPrice * closeSlippageMult });
  }

  let chosen: Candidate | null = null;
  if (candidates.length === 1) {
    chosen = candidates[0]!;
  } else if (candidates.length > 1) {
    const priority = stratConfig?.exitPriority?.length ? stratConfig.exitPriority : ["stop_loss", "take_profit", "trailing_stop", "timeout"];
    for (const key of priority) {
      const match = candidates.find((c) => c.key === key);
      if (match) { chosen = match; break; }
    }
    chosen ??= candidates[0]!; // safety net — unreachable given the fallback list
  }

  if (!chosen || !(chosen.exitPrice > 0)) return null;

  const { reason: exitReason, exitPrice } = chosen;
  const exitQty = pos.remainingQty;
  // A take-profit is a resting LIMIT the market fills into → maker fee. A
  // stop / trailing / break-even / timeout / liquidation is an aggressive
  // market close → taker fee. (Equal when makerFeeRate is unset.)
  const exitFeeRate = exitReason === "take_profit" ? makerFeeRate : feeRate;
  const exitFees = exitPrice * exitQty * exitFeeRate;
  const finalSlicePnl = (isShort ? pos.entryPrice - exitPrice : exitPrice - pos.entryPrice) * exitQty - exitFees;
  const partialPnl = pos.partialExits.reduce((s, p) => s + p.pnl, 0);
  const partialFees = pos.partialExits.reduce((s, p) => s + p.fees, 0);
  // Partial exits charge their pro-rata ENTRY-fee share; the final slice must
  // charge its own too, or the unclosed share of entry fees is never paid and
  // results are overstated. Charging it here keeps net = gross − totalFees
  // exactly.
  const entryFeeShareFinal = pos.qty > 0 ? pos.fees * (exitQty / pos.qty) : pos.fees;
  const pnl = finalSlicePnl + partialPnl - entryFeeShareFinal; // NET across every slice
  const grossPnl = (isShort ? pos.entryPrice - exitPrice : exitPrice - pos.entryPrice) * exitQty
    + pos.partialExits.reduce((s, p) => s + (isShort ? pos.entryPrice - p.price : p.price - pos.entryPrice) * p.qty, 0);
  // partialFees already contain the partials' entry-fee shares — summing the
  // final slice's share (not the whole pos.fees) avoids a double count and
  // makes totalFees the exact all-in cost of the trade.
  const totalFees = entryFeeShareFinal + exitFees + partialFees;
  const durationSeconds = Math.round((ctx.now.getTime() - pos.entryTime.getTime()) / 1000);
  // Direction-agnostic: for a short both (tp − entry) and (entry − plannedSl)
  // are negative, so the ratio comes out the same sign as a long's.
  const riskReward =
    pos.entryPrice - pos.plannedSlPrice !== 0
      ? (pos.tpPrice - pos.entryPrice) / (pos.entryPrice - pos.plannedSlPrice)
      : 0;
  const notional = pos.entryPrice * pos.qty;

  return {
    exitPrice,
    exitReason,
    pnl,
    grossPnl,
    // Net-of-fees, not gross — a gross-only percentage can show a positive %
    // on a net-losing trade.
    pnlPercent: notional > 0 ? (pnl / notional) * 100 : 0,
    totalFees,
    totalSlippage: Math.abs(pos.slippage) + Math.abs(exitPrice * exitQty * slippageRate),
    durationSeconds,
    riskReward,
  };
}
