/**
 * TradeCore Pro — DemoExecutor
 *
 * Executes an approved TradePlan inside TradeCore's own simulation: no broker,
 * no API keys, no real money, but real live market data and the SAME fill
 * model the backtest runs (execution/fillModel.ts).
 *
 * That shared fill model is the whole design. A demo that filled by its own
 * rules would make both the demo and the backtest untrustworthy — a user who
 * saw one result in paper and a different one in a backtest of the same setup
 * would be right not to believe either. Entry costs here (taker fee, adverse
 * slippage) use the same rates the backtest applies, so the numbers mean the
 * same thing everywhere in the product.
 *
 * A demo trade is a normal `trades` row with `executionTarget = "demo"`. That
 * is deliberate: the trade log, journal, analytics, post-mortems, and edge
 * forensics all work on demo accounts with no special-casing, because it is
 * genuinely the same data. Analytics can separate demo from live on that one
 * column — presenting a paper win rate as a live one would be a lie.
 *
 * Exits are NOT handled here. A position closes when the market reaches a
 * level, which is a per-tick question — see demoExit.ts.
 */
import { db, tradesTable } from "@workspace/db";
import { computeTp1Tp2Ladder } from "../strategies";
import { logger } from "../logger";
import { openIntent, advanceIntent, attachTrade } from "./intentLog";
import { planFingerprint } from "../plan/fingerprint";
import type { ExecutionRequest, ExecutionResult, TradeExecutor } from "./executor";
import type { FillCosts } from "./fillModel";
import type { Section } from "../engineRegistry";

/**
 * Accessors rather than values: BotEngine constructs this as a field
 * initializer, which runs before its constructor parameter properties exist.
 * Same reason ExitManager's host is function-shaped.
 */
export interface DemoExecutorHost {
  userId: () => number;
  section: () => Section;
  /** Cost model — identical rates to the backtest for this market type. */
  costs: () => FillCosts;
  /** Virtual balance available right now (starting balance + realised P&L). */
  balance: () => Promise<number>;
}

export class DemoExecutor implements TradeExecutor {
  readonly kind = "demo" as const;

  constructor(private readonly host: DemoExecutorHost) {}

  async execute(req: ExecutionRequest): Promise<ExecutionResult> {
    const { plan, row, config, now, stratConfig } = req;
    const costs = this.host.costs();
    const isShort = plan.side === "short";
    const openSide = isShort ? "sell" : "buy";

    // ── Pre-flight: the simulation still refuses trades it cannot afford ─────
    // A demo that ignores margin would teach the wrong lesson, and its
    // analytics would describe a portfolio nobody could actually hold.
    const balance = await this.host.balance();
    const leverage = Math.max(1, plan.leverage || 1);
    const requiredMargin = (plan.qty * plan.entryPrice) / leverage;
    if (requiredMargin > balance * 0.98) {
      return {
        entered: false,
        reason: `Insufficient demo balance: needs ~$${requiredMargin.toFixed(2)} at ${leverage}x, only $${balance.toFixed(2)} available`,
      };
    }

    // The intent log applies here too. Nothing external happens, so it can
    // never be orphaned — but keeping the record identical means the audit
    // trail, the correlation id, and every downstream join behave the same in
    // demo as in live, which is exactly what makes demo a faithful rehearsal.
    const intent = await openIntent({
      userId: this.host.userId(),
      section: this.host.section(),
      planFingerprint: planFingerprint(this.host.userId(), plan),
      symbol: req.symbol,
      side: openSide,
      marketType: config.marketType,
      ...(plan.strategyId && { strategyId: plan.strategyId }),
      plannedEntryPrice: plan.entryPrice,
      plannedStopLoss: plan.slPrice,
      plannedTakeProfit: plan.tpPrice,
      plannedQuantity: plan.qty,
      plannedLeverage: leverage,
    });
    await advanceIntent(intent, "ORDER_SUBMITTED", "simulated market entry");

    // ── The fill ─────────────────────────────────────────────────────────────
    // Adverse slippage on entry: a buy fills higher, a sell fills lower —
    // the same direction convention the backtest applies on exits.
    const fillPrice = plan.entryPrice * (isShort ? 1 - costs.slippageRate : 1 + costs.slippageRate);
    const filledQty = plan.qty;
    // Entry fees are NOT stored here. A demo close runs through the same
    // ExitManager accounting a live close does, which recomputes both legs'
    // fees from the taker rate — so the split is clean: the fill model decides
    // WHERE the market took the position out, ExitManager decides what that
    // was worth. Demo P&L is therefore produced by the identical code as live
    // P&L, not a parallel implementation that could drift.

    // Re-anchor SL/TP to the actual fill, preserving the strategy's intended
    // risk and reward DISTANCES — the same re-anchoring live does, so the
    // dollar risk stays the one the position was sized against.
    const slDistance = isShort ? plan.slPrice - plan.entryPrice : plan.entryPrice - plan.slPrice;
    const tpDistance = isShort ? plan.entryPrice - plan.tpPrice : plan.tpPrice - plan.entryPrice;
    const realSl = isShort ? fillPrice + slDistance : fillPrice - slDistance;
    const realTp = isShort ? fillPrice - tpDistance : fillPrice + tpDistance;

    // Same risk guard as live: no valid stop, no position.
    const slValid = isShort ? realSl > fillPrice : realSl > 0 && realSl < fillPrice;
    const tpValid = isShort ? realTp > 0 && realTp < fillPrice : realTp > fillPrice;
    if (!slValid || !tpValid) {
      await advanceIntent(intent, "FLATTENED", "risk guard: computed SL/TP invalid after simulated fill");
      return { entered: false, reason: "Risk guard: computed SL/TP invalid after fill — no position opened" };
    }

    await advanceIntent(intent, "FILLED", "simulated fill", { fillPrice, filledQty });

    const ladder = stratConfig
      ? computeTp1Tp2Ladder(fillPrice, realSl, realTp, filledQty, stratConfig, (p) => p, (q) => q, plan.side)
      : { tp1Price: 0, tp1Qty: 0, tp2Price: 0, tp2Qty: 0 };

    try {
      const [trade] = await db
        .insert(tradesTable)
        .values({
          userId: this.host.userId(),
          section: this.host.section(),
          executionTarget: "demo",
          symbol: req.symbol,
          side: openSide,
          marketType: config.marketType,
          ...(leverage > 1 && { leverage, marginMode: config.marginMode }),
          entryPrice: fillPrice.toFixed(8),
          quantity: filledQty.toFixed(8),
          status: "open",
          confidence: row.confidence.toFixed(2),
          stopLoss: realSl.toFixed(8),
          takeProfit: realTp.toFixed(8),
          entryTime: now,
          ...(plan.strategyId && { strategyId: plan.strategyId }),
          ...(plan.strategyName && { strategyName: plan.strategyName }),
          plannedStopLoss: plan.slPrice.toFixed(8),
          plannedTakeProfit: plan.tpPrice.toFixed(8),
          plannedQuantity: plan.qty.toFixed(8),
          remainingQuantity: filledQty.toFixed(8),
          ...(ladder.tp1Price > 0 && { tp1Price: ladder.tp1Price.toFixed(8), tp1Quantity: ladder.tp1Qty.toFixed(8) }),
          ...(ladder.tp2Price > 0 && { tp2Price: ladder.tp2Price.toFixed(8), tp2Quantity: ladder.tp2Qty.toFixed(8) }),
          entryReason: plan.report.summary,
          tradePlan: plan,
          expectedHoldSeconds: Math.round(plan.expectedHoldSeconds),
          maxHoldSeconds: Math.round(plan.maxHoldSeconds),
          plannedLeverage: plan.leverage,
          ...(intent && { correlationId: intent.correlationId }),
        })
        .returning();

      await attachTrade(intent, trade!.id);
      await advanceIntent(intent, "RECORDED", "demo trade row written", { tradeId: trade!.id });
      // A simulated position needs no exchange-side protection: its stop and
      // target are enforced by the fill model on every tick, which cannot fail
      // to place. This is terminal-good for a demo intent.
      await advanceIntent(intent, "PROTECTED", "simulated SL/TP active (enforced by the fill model)");

      logger.info(
        {
          tradeId: trade!.id, symbol: req.symbol, side: plan.side,
          fillPrice: fillPrice.toFixed(6), sl: realSl.toFixed(6), tp: realTp.toFixed(6),
          qty: filledQty, strategy: plan.strategyName,
        },
        "DEMO trade entered (simulated fill — no broker involved)",
      );

      return {
        entered: true,
        reason: `simulated ${openSide.toUpperCase()} filled at ${fillPrice.toFixed(6)} — demo account, no real order placed`,
        ...(intent && { correlationId: intent.correlationId }),
        tradeId: trade!.id,
      };
    } catch (err) {
      await advanceIntent(intent, "FAILED", String((err as Error)?.message ?? err));
      logger.error({ err, symbol: req.symbol }, "Failed to record demo trade");
      return { entered: false, reason: `Demo entry failed: ${String((err as Error)?.message ?? err)}` };
    }
  }
}
