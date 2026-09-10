/**
 * FILL-MODEL test — the simulation the Demo account and the backtest share.
 *
 * This code decides what a simulated position is worth, so its edge cases are
 * the ones that decide whether a demo is honest. The cases below are the ones
 * that flatter a simulation if you get them wrong: a bar that touches both the
 * stop and the target, slippage applied in the favourable direction, an
 * excursion measured after the exit instead of before it, entry fees quietly
 * never charged on the unclosed remainder.
 *
 * Pure — no DB, no network. The extraction from backtestEngine is separately
 * proven behaviour-neutral by the harness Δ0 gate; this pins the behaviour
 * itself so a future edit cannot loosen it silently.
 *
 * Run:  tsx harness/fill-model.test.ts   (exit 0 = pass)
 */
import {
  manageBar, settleBar, updateExcursion,
  type BarContext, type FillCosts, type SimulatedPosition,
} from "../src/lib/execution/fillModel";
import type { StrategyConfig } from "../src/lib/strategies";

let failures = 0;
function expect(name: string, cond: boolean, detail = "") {
  if (!cond) {
    failures++;
    console.error(`✗  ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    console.log(`✓  ${name}`);
  }
}
const near = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol;

const T0 = new Date("2025-06-01T12:00:00Z");
const bar = (o: number, h: number, l: number, c: number, tMs = T0.getTime()): [number, number, number, number, number, number] =>
  [tMs, o, h, l, c, 100];

const NO_COSTS: FillCosts = { feeRate: 0, makerFeeRate: 0, slippageRate: 0 };

function longPos(over: Partial<SimulatedPosition> = {}): SimulatedPosition {
  return {
    symbol: "BTCUSDT", side: "long",
    entryPrice: 100, slPrice: 95, tpPrice: 110, plannedSlPrice: 95,
    qty: 1, remainingQty: 1, entryTime: T0, confidence: 70,
    fees: 0, slippage: 0, leverage: 1,
    mfe: 0, mae: 0,
    tp1Price: 0, tp1Qty: 0, tp1Filled: false,
    tp2Price: 0, tp2Qty: 0, tp2Filled: false,
    breakEvenActive: false, trailingStopActive: false,
    partialExits: [],
    ...over,
  };
}

const cfg = (over: Partial<StrategyConfig> = {}): StrategyConfig => ({
  tp1RMultiple: 0, tp3Enabled: false, trailingStopMode: "none",
  trailingAfterTp1Only: true, breakEvenRMultiple: 0,
  emergencyTrailingRMultiple: 0, emergencyTrailingPercent: 0.5,
  trailingStopPercent: 1, trailingStopAtrMultiplier: 2,
  maxHoldingSeconds: 7200, cooldownMinutes: 5,
  exitPriority: [],
  ...over,
} as unknown as StrategyConfig);

const ctxAt = (candle: ReturnType<typeof bar>, now = T0): BarContext =>
  ({ candle, history: [candle], now });

// ── Excursion is measured BEFORE the exit ───────────────────────────────────
// A bar that both makes a new high and hits the stop must still count that
// high, or MFE systematically understates how far winners ran.
{
  const pos = longPos();
  updateExcursion(pos, 108, 94);
  expect("MFE counts the bar's high", near(pos.mfe, 8));
  expect("MAE counts the bar's low", near(pos.mae, -6));
  updateExcursion(pos, 103, 97);
  expect("a milder bar does not shrink MFE", near(pos.mfe, 8));
  expect("a milder bar does not shrink MAE", near(pos.mae, -6));
}
{
  const short = longPos({ side: "short", slPrice: 105, tpPrice: 90, plannedSlPrice: 105 });
  updateExcursion(short, 108, 94);
  expect("short MFE is measured DOWNWARD", near(short.mfe, 6));
  expect("short MAE is measured UPWARD", near(short.mae, -8));
}

// ── Slippage always hurts ───────────────────────────────────────────────────
{
  const costs: FillCosts = { feeRate: 0, makerFeeRate: 0, slippageRate: 0.001 };
  const pos = longPos();
  const out = settleBar(pos, ctxAt(bar(100, 111, 99, 110)), cfg(), costs);
  expect("long take-profit fills BELOW the target (adverse)", !!out && out.exitPrice < 110, String(out?.exitPrice));
  const short = longPos({ side: "short", slPrice: 105, tpPrice: 90, plannedSlPrice: 105 });
  const sOut = settleBar(short, ctxAt(bar(100, 101, 89, 90)), cfg(), costs);
  expect("short take-profit fills ABOVE the target (adverse)", !!sOut && sOut.exitPrice > 90, String(sOut?.exitPrice));
}

// ── The co-touch bar: the case that flatters a bad simulation ───────────────
// One bar's range covers both the stop and the target. OHLC cannot say which
// came first, so the default must be the pessimistic one.
{
  const pos = longPos();
  const out = settleBar(pos, ctxAt(bar(100, 111, 94, 100)), cfg(), NO_COSTS);
  expect("stop wins over target by default (conservative)", out?.exitReason === "stop_loss", String(out?.exitReason));

  const optimistic = longPos();
  const out2 = settleBar(optimistic, ctxAt(bar(100, 111, 94, 100)), cfg({ exitPriority: ["take_profit", "stop_loss"] }), NO_COSTS);
  expect("configured exitPriority can override the tie-break", out2?.exitReason === "take_profit", String(out2?.exitReason));
}

// ── Nothing touched ⇒ position stays open ───────────────────────────────────
{
  const pos = longPos();
  expect("a quiet bar leaves the position open", settleBar(pos, ctxAt(bar(100, 102, 98, 101)), cfg(), NO_COSTS) === null);
}

// ── Timeout, and the stale-thesis early exit ────────────────────────────────
{
  const pos = longPos({ maxHoldSeconds: 600 });
  const later = new Date(T0.getTime() + 601_000);
  const out = settleBar(pos, { candle: bar(100, 101, 99, 100, later.getTime()), history: [], now: later }, cfg(), NO_COSTS);
  expect("hard deadline closes the position", out?.exitReason === "timeout");
}
{
  // Held 2× the EXPECTED resolution, price still glued to entry → cut early.
  const pos = longPos({ expectedHoldSeconds: 300, maxHoldSeconds: 100_000 });
  const later = new Date(T0.getTime() + 601_000);
  const out = settleBar(pos, { candle: bar(100, 100.2, 99.8, 100, later.getTime()), history: [], now: later }, cfg({ maxHoldingSeconds: 100_000 }), NO_COSTS);
  expect("stale thesis exits early as a timeout", out?.exitReason === "timeout");

  // Same elapsed time, but the trade is actually working → let it run.
  const working = longPos({ expectedHoldSeconds: 300, maxHoldSeconds: 100_000 });
  const out2 = settleBar(working, { candle: bar(100, 104, 103, 103.5, later.getTime()), history: [], now: later }, cfg({ maxHoldingSeconds: 100_000 }), NO_COSTS);
  expect("a moving trade is NOT cut as stale", out2 === null, String(out2?.exitReason));
}

// ── Fee accounting: net must equal gross minus every fee ────────────────────
{
  const costs: FillCosts = { feeRate: 0.001, makerFeeRate: 0.001, slippageRate: 0 };
  const pos = longPos({ fees: 100 * 1 * 0.001 }); // entry fee actually paid
  const out = settleBar(pos, ctxAt(bar(100, 111, 99, 110)), cfg(), costs)!;
  expect("net = gross − total fees, exactly", near(out.pnl, out.grossPnl - out.totalFees, 1e-9),
    `pnl ${out.pnl} vs ${out.grossPnl - out.totalFees}`);
  expect("total fees include BOTH legs", near(out.totalFees, 0.1 + 110 * 0.001, 1e-9), String(out.totalFees));
  expect("pnlPercent is net-of-fees, not gross", out.pnlPercent < (out.grossPnl / 100) * 100);
}

// The regression this guards: partial exits charge a pro-rata entry-fee share,
// and the final slice must charge its own. Miss it and every laddered trade
// overstates by the unclosed share.
{
  const costs: FillCosts = { feeRate: 0.001, makerFeeRate: 0.001, slippageRate: 0 };
  const pos = longPos({
    fees: 0.1, qty: 1, remainingQty: 1,
    tp1Price: 105, tp1Qty: 0.5,
  });
  const management = cfg({ tp1RMultiple: 1, maxHoldingSeconds: 100_000 });
  manageBar(pos, ctxAt(bar(100, 106, 99, 105)), management, costs);
  expect("TP1 filled half the position", near(pos.remainingQty, 0.5) && pos.tp1Filled);
  expect("TP1 moved the stop to break-even", near(pos.slPrice, 100) && pos.breakEvenActive);

  const out = settleBar(pos, ctxAt(bar(105, 111, 104, 110)), management, costs)!;
  const entryFeesCharged = 0.1; // the whole entry fee, across both slices
  const exitFees = 105 * 0.5 * 0.001 + 110 * 0.5 * 0.001;
  expect("entry fee is charged exactly once across all slices",
    near(out.totalFees, entryFeesCharged + exitFees, 1e-9), String(out.totalFees));
  expect("net still equals gross − fees after a partial", near(out.pnl, out.grossPnl - out.totalFees, 1e-9));
}

// ── Break-even arms before TP1 and only ever tightens ───────────────────────
{
  const pos = longPos();
  const c = cfg({ tp1RMultiple: 1, breakEvenRMultiple: 1, maxHoldingSeconds: 100_000 });
  manageBar(pos, ctxAt(bar(100, 106, 99, 105.5)), c, NO_COSTS); // +1.1R unrealised
  expect("break-even arms once profit reaches the R threshold", near(pos.slPrice, 100) && pos.breakEvenActive);
  manageBar(pos, ctxAt(bar(105, 105, 100, 100.5)), c, NO_COSTS);
  expect("the stop never loosens afterwards", near(pos.slPrice, 100));
}

// ── Liquidation never pre-empts a nearer stop ───────────────────────────────
{
  const pos = longPos({ liquidationPrice: 90 });
  const out = settleBar(pos, ctxAt(bar(100, 101, 89, 92)), cfg(), NO_COSTS);
  expect("stop is chosen over liquidation when both are touched", out?.exitReason === "stop_loss", String(out?.exitReason));

  const gapped = longPos({ slPrice: 80, plannedSlPrice: 80, liquidationPrice: 90 });
  const out2 = settleBar(gapped, ctxAt(bar(100, 101, 89, 92)), cfg(), NO_COSTS);
  expect("liquidation fires when it is the sole trigger", out2?.exitReason === "liquidation", String(out2?.exitReason));
}

// Management must not book a partial profit before a pre-existing stop that
// the same OHLC bar also touched. Exercise the actual manage -> settle chain.
for (const side of ["long", "short"] as const) {
  const short = side === "short";
  const management = cfg({ tp1RMultiple: 1 });
  const pos = longPos({
    side, slPrice: short ? 105 : 95, plannedSlPrice: short ? 105 : 95,
    tpPrice: short ? 90 : 110, tp1Price: short ? 95 : 105, tp1Qty: 0.5,
  });
  const ctx = ctxAt(short ? bar(100, 106, 94, 96) : bar(100, 106, 94, 104));
  manageBar(pos, ctx, management, NO_COSTS);
  const out = settleBar(pos, ctx, management, NO_COSTS);
  expect(`${side}: pre-existing stop prevents ambiguous TP1 profit`, !pos.tp1Filled && pos.partialExits.length === 0);
  expect(`${side}: full original stop loss is recorded`, out?.exitReason === "stop_loss" && near(out.pnl, -5), String(out?.pnl));

  const protectedPos = longPos({
    side, slPrice: short ? 98 : 102, plannedSlPrice: short ? 105 : 95,
    tpPrice: short ? 90 : 110, tp1Price: short ? 95 : 105, tp1Qty: 0.5,
    trailingStopActive: true,
  });
  const protectedCtx = ctxAt(short ? bar(97, 97, 94, 95) : bar(103, 106, 103, 105));
  manageBar(protectedPos, protectedCtx, management, NO_COSTS);
  expect(`${side}: TP1 preserves a tighter existing stop`, protectedPos.tp1Filled && near(protectedPos.slPrice, short ? 98 : 102));
}

console.log(failures === 0 ? "\nAll fill-model checks passed." : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
