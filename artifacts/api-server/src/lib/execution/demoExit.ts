/**
 * TradeCore Pro — demo exit simulation
 *
 * The per-tick counterpart to DemoExecutor. A live position closes when the
 * exchange reports a fill; a demo position closes when the market reaches a
 * level, which only the fill model can decide.
 *
 * The division of labour matters and is deliberate:
 *
 *   execution/fillModel.ts  decides WHETHER this bar took the position out,
 *                           at what price, and why — the market simulation,
 *                           shared verbatim with the backtest.
 *   ExitManager.closeSimulated  decides what that was WORTH — the same P&L,
 *                           fee, risk-audit, post-mortem and cooldown path a
 *                           live close runs.
 *
 * Neither half is duplicated. A demo trade and a live trade are settled by
 * identical code; only the question "did it fill?" is answered differently,
 * which is the one thing that genuinely differs.
 */
import { db, tradesTable, tradePartialExitsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../logger";
import type { Candle } from "../strategy";
import type { StrategyConfig } from "../strategies";
import type { ExitManager } from "../exitManager";
import type { PositionManagementAction } from "../intelligence/position";
import {
  manageBar, settleBar, updateExcursion,
  type BarContext, type FillCosts, type SimulatedPosition,
} from "./fillModel";

type Trade = typeof tradesTable.$inferSelect;

/**
 * Rebuild the in-memory position the fill model works on from the persisted
 * trade row. Every field the model mutates is read back from the DB each tick,
 * so an engine restart resumes a demo position exactly where it left off —
 * there is no in-process state to lose.
 */
function positionFromTrade(trade: Trade): SimulatedPosition {
  const isShort = trade.side === "sell";
  return {
    symbol: trade.symbol,
    side: isShort ? "short" : "long",
    entryPrice: Number(trade.entryPrice),
    slPrice: Number(trade.stopLoss),
    tpPrice: Number(trade.takeProfit),
    plannedSlPrice: Number(trade.plannedStopLoss ?? trade.stopLoss),
    qty: Number(trade.quantity),
    remainingQty: Number(trade.remainingQuantity ?? trade.quantity),
    entryTime: new Date(trade.entryTime),
    confidence: Number(trade.confidence),
    // Entry fees are recomputed by ExitManager at close from the taker rate,
    // exactly as they are for a live trade — see closeSimulated.
    fees: 0,
    slippage: 0,
    ...(trade.liquidationPrice != null && { liquidationPrice: Number(trade.liquidationPrice) }),
    ...(trade.strategyId && { strategyId: trade.strategyId }),
    ...(trade.strategyName && { strategyName: trade.strategyName }),
    leverage: trade.leverage ?? 1,
    ...(trade.maxHoldSeconds != null && { maxHoldSeconds: Number(trade.maxHoldSeconds) }),
    ...(trade.expectedHoldSeconds != null && { expectedHoldSeconds: Number(trade.expectedHoldSeconds) }),
    mfe: trade.mfeUsdt != null ? Number(trade.mfeUsdt) : 0,
    mae: trade.maeUsdt != null ? Number(trade.maeUsdt) : 0,
    tp1Price: trade.tp1Price != null ? Number(trade.tp1Price) : 0,
    tp1Qty: trade.tp1Quantity != null ? Number(trade.tp1Quantity) : 0,
    tp1Filled: Boolean(trade.tp1Filled),
    ...(trade.tp1FillPrice != null && { tp1FillPrice: Number(trade.tp1FillPrice) }),
    ...(trade.tp1FillTime != null && { tp1FillTime: new Date(trade.tp1FillTime) }),
    tp2Price: trade.tp2Price != null ? Number(trade.tp2Price) : 0,
    tp2Qty: trade.tp2Quantity != null ? Number(trade.tp2Quantity) : 0,
    tp2Filled: Boolean(trade.tp2Filled),
    ...(trade.tp2FillPrice != null && { tp2FillPrice: Number(trade.tp2FillPrice) }),
    ...(trade.tp2FillTime != null && { tp2FillTime: new Date(trade.tp2FillTime) }),
    breakEvenActive: trade.breakEvenActive,
    trailingStopActive: trade.trailingStopActive,
    ...(trade.trailingStopMode && { trailingStopMode: trade.trailingStopMode }),
    ...(trade.trailingStopArmedPrice != null && {
      trailingStopArmedPrice: Number(trade.trailingStopArmedPrice),
    }),
    partialExits: [],
  };
}

export interface DemoExitArgs {
  trade: Trade;
  candles1m: Candle[];
  now: Date;
  cooldownMinutes: number;
  stratConfig: StrategyConfig | undefined;
  costs: FillCosts;
  exitManager: ExitManager;
  /** Present only when Phase 7 is the pinned owner. Fixed manageBar is skipped
   * so two managers can never mutate the same simulated position. */
  phase7Action?: PositionManagementAction;
  phase7OwnsManagement?: boolean;
  onPhase7Result?: (result: DemoPhase7Result) => Promise<void>;
}

export interface DemoPhase7Result {
  actionApplied: boolean;
  closed: boolean;
  remainingQuantity: number;
  stopLoss: number;
  reason: string;
}

export async function closeDemoManually(args: {
  trade: Trade;
  markPrice: number;
  now: Date;
  cooldownMinutes: number;
  costs: FillCosts;
  exitManager: ExitManager;
}) {
  if (args.trade.executionTarget !== "demo") {
    throw new Error("Simulated close refused for a non-Demo trade");
  }
  if (!Number.isFinite(args.markPrice) || args.markPrice <= 0) {
    throw new Error("Demo manual close requires a finite current market price");
  }
  const isShort = args.trade.side === "sell";
  const exitPrice = args.markPrice * (isShort ? 1 + args.costs.slippageRate : 1 - args.costs.slippageRate);
  return args.exitManager.closeSimulated(
    args.trade,
    "manual",
    exitPrice,
    args.now,
    args.cooldownMinutes,
  );
}

/**
 * Advance one demo position by one bar. Persists any partial fill or stop
 * move, and closes the trade if the bar resolved it.
 *
 * Returns true when the position closed.
 */
export async function simulateDemoExit(args: DemoExitArgs): Promise<boolean> {
  const { trade, candles1m, now, cooldownMinutes, stratConfig, costs, exitManager } = args;
  if (candles1m.length === 0) return false;

  const candle = candles1m[candles1m.length - 1]!;
  const [, , high, low] = candle;
  const pos = positionFromTrade(trade);
  const ctx: BarContext = { candle, history: candles1m, now };

  const slBefore = pos.slPrice;
  updateExcursion(pos, high, low);
  if (args.phase7Action) {
    const action = args.phase7Action;
    if ((action.type === "TIGHTEN_STOP" || action.type === "APPLY_TRAILING") && action.proposedStopPrice !== null) {
      pos.slPrice = action.proposedStopPrice;
      pos.breakEvenActive ||= action.type === "TIGHTEN_STOP" && pos.slPrice === pos.entryPrice;
      pos.trailingStopActive ||= action.type === "APPLY_TRAILING";
      if (action.type === "APPLY_TRAILING") {
        pos.trailingStopMode = "phase7-atr";
        pos.trailingStopArmedPrice = pos.slPrice;
      }
    } else if (action.type === "REDUCE" && action.reductionFraction !== null) {
      const qty = Math.min(pos.remainingQty * action.reductionFraction, pos.remainingQty * 0.5);
      if (qty > 0 && qty < pos.remainingQty) {
        const isShort = pos.side === "short";
        const fillPrice = ctx.candle[4] * (isShort ? 1 + costs.slippageRate : 1 - costs.slippageRate);
        const fees = (pos.entryPrice + fillPrice) * qty * costs.feeRate;
        const pnl = (isShort ? pos.entryPrice - fillPrice : fillPrice - pos.entryPrice) * qty - fees;
        pos.partialExits.push({ reason: "phase7_reduce", qty, price: fillPrice, fees, pnl, time: now });
        pos.remainingQty -= qty;
      }
    } else if (action.type === "EXIT") {
      const exitPrice = ctx.candle[4] * (pos.side === "short" ? 1 + costs.slippageRate : 1 - costs.slippageRate);
      const outcome = await exitManager.closeSimulated(trade, "signal_exit", exitPrice, now, cooldownMinutes);
      await args.onPhase7Result?.({
        actionApplied: outcome.closed,
        closed: outcome.closed,
        remainingQuantity: pos.remainingQty,
        stopLoss: pos.slPrice,
        reason: outcome.closed ? "thesis invalidation exit settled" : "thesis invalidation exit failed",
      });
      return outcome.closed;
    }
  } else if (!args.phase7OwnsManagement) {
    manageBar(pos, ctx, stratConfig, costs);
  }

  // Persist anything trade management changed BEFORE evaluating the close, so
  // a crash between the two leaves the position in its true current state
  // rather than silently discarding a partial fill.
  if (pos.partialExits.length > 0) {
    for (const p of pos.partialExits) {
      try {
        await db.insert(tradePartialExitsTable).values({
          tradeId: trade.id,
          reason: p.reason,
          quantity: p.qty.toFixed(8),
          price: p.price.toFixed(8),
          fees: p.fees.toFixed(8),
          pnl: p.pnl.toFixed(8),
          time: p.time,
        });
      } catch (err) {
        logger.warn({ err, tradeId: trade.id, reason: p.reason }, "DEMO_PARTIAL_PERSIST_FAILED");
        if (p.reason === "phase7_reduce") throw err;
      }
    }
  }

  const slMoved = pos.slPrice !== slBefore;
  const managementProjectionChanged =
    slMoved ||
    pos.partialExits.length > 0 ||
    pos.tp1Filled !== trade.tp1Filled ||
    pos.tp2Filled !== trade.tp2Filled ||
    pos.breakEvenActive !== trade.breakEvenActive ||
    pos.trailingStopActive !== trade.trailingStopActive ||
    (pos.trailingStopMode ?? null) !== trade.trailingStopMode ||
    (pos.trailingStopArmedPrice ?? null) !==
      (trade.trailingStopArmedPrice != null ? Number(trade.trailingStopArmedPrice) : null) ||
    pos.mfe !== Number(trade.mfeUsdt ?? 0) ||
    pos.mae !== Number(trade.maeUsdt ?? 0);
  if (managementProjectionChanged) {
    try {
      await db
        .update(tradesTable)
        .set({
          stopLoss: pos.slPrice.toFixed(8),
          remainingQuantity: pos.remainingQty.toFixed(8),
          tp1Filled: pos.tp1Filled,
          tp1FillPrice: pos.tp1FillPrice != null ? pos.tp1FillPrice.toFixed(8) : null,
          tp1FillTime: pos.tp1FillTime ?? null,
          tp2Filled: pos.tp2Filled,
          tp2FillPrice: pos.tp2FillPrice != null ? pos.tp2FillPrice.toFixed(8) : null,
          tp2FillTime: pos.tp2FillTime ?? null,
          breakEvenActive: pos.breakEvenActive,
          trailingStopActive: pos.trailingStopActive,
          trailingStopMode: pos.trailingStopMode ?? null,
          trailingStopArmedPrice:
            pos.trailingStopArmedPrice != null ? pos.trailingStopArmedPrice.toFixed(8) : null,
          ...(args.phase7Action?.type === "REDUCE" && pos.partialExits.length > 0 && { phase7ReductionApplied: true }),
          mfeUsdt: pos.mfe.toFixed(8),
          maeUsdt: pos.mae.toFixed(8),
        })
        .where(eq(tradesTable.id, trade.id));
      // Keep the in-memory row in step for the settlement below.
      trade.stopLoss = pos.slPrice.toFixed(8);
      trade.remainingQuantity = pos.remainingQty.toFixed(8);
      trade.tp1Filled = pos.tp1Filled;
      trade.tp1FillPrice = pos.tp1FillPrice != null ? pos.tp1FillPrice.toFixed(8) : null;
      trade.tp1FillTime = pos.tp1FillTime ?? null;
      trade.tp2Filled = pos.tp2Filled;
      trade.tp2FillPrice = pos.tp2FillPrice != null ? pos.tp2FillPrice.toFixed(8) : null;
      trade.tp2FillTime = pos.tp2FillTime ?? null;
      trade.breakEvenActive = pos.breakEvenActive;
      trade.trailingStopActive = pos.trailingStopActive;
      trade.trailingStopMode = pos.trailingStopMode ?? null;
      trade.trailingStopArmedPrice =
        pos.trailingStopArmedPrice != null ? pos.trailingStopArmedPrice.toFixed(8) : null;
    } catch (err) {
      logger.warn({ err, tradeId: trade.id }, "DEMO_MANAGE_PERSIST_FAILED");
      if (args.phase7OwnsManagement) throw err;
    }
  }

  const settled = settleBar(pos, ctx, stratConfig, costs);
  if (!settled) {
    if (args.phase7Action) {
      await args.onPhase7Result?.({
        actionApplied: !["HOLD", "FREEZE"].includes(args.phase7Action.type)
          ? slMoved || pos.partialExits.length > 0
          : true,
        closed: false,
        remainingQuantity: pos.remainingQty,
        stopLoss: pos.slPrice,
        reason: args.phase7Action.type,
      });
    }
    return false;
  }

  logger.info(
    {
      tradeId: trade.id, symbol: trade.symbol,
      exitReason: settled.exitReason, exitPrice: settled.exitPrice.toFixed(6),
    },
    "DEMO position resolved by the fill model — settling through the live accounting path",
  );

  const outcome = await exitManager.closeSimulated(
    trade, settled.exitReason, settled.exitPrice, now, cooldownMinutes,
  );
  if (args.phase7Action) {
    await args.onPhase7Result?.({
      actionApplied: true,
      closed: outcome.closed,
      remainingQuantity: pos.remainingQty,
      stopLoss: pos.slPrice,
      reason: `baseline ${settled.exitReason} settled after Phase 7 evaluation`,
    });
  }
  return outcome.closed;
}
