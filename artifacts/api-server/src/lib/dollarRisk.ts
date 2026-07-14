/**
 * TradeCore Pro — Dollar-based risk model (Phase 8)
 *
 * A trader-first alternative to the percentage-based SL/TP model. Instead of
 * "put the stop 1.5% below entry", the user states two plain-dollar amounts:
 *
 *   • maxLossUsdt      — the most they are willing to LOSE on the trade
 *   • targetProfitUsdt — the profit they want to MAKE on the trade
 *
 * …together with the position's notional (positionSizeUsdt for spot; margin ×
 * leverage for futures). From those the engine derives EVERYTHING else:
 * position size, the exact stop-loss price, the take-profit price, the price
 * distances as %, the reward:risk ratio, expected P&L, round-trip fees, and —
 * for futures — the liquidation price, the distance to it, and whether the
 * stop would sit safely inside liquidation.
 *
 * This module is pure and is the SINGLE SOURCE OF TRUTH: the live engine, paper
 * trading and the backtest all size dollar-model trades through planDollarRisk()
 * so results are identical across all three. The UI mirrors the same closed-form
 * fractions (planDollarRiskFractions) to show the user exactly what they are
 * risking BEFORE a trade is opened.
 *
 * KEY INSIGHT (why the preview is exact without knowing the coin's price): the
 * SL/TP price *distances* and the liquidation distance are all fractions of
 * entry that depend ONLY on the dollar amounts, the notional and the leverage —
 * never on the absolute price. So:
 *
 *   slFraction = (maxLossUsdt − roundTripFees) / notional
 *   tpFraction = (targetProfitUsdt + roundTripFees) / notional
 *
 * (fees are charged on both legs whether you win or lose, so they widen the
 * effective stop and the required target symmetrically). Multiplying by an
 * entry price yields the actual SL/TP levels; the fractions themselves are
 * price-independent, which is what makes the Settings preview accurate.
 */
import {
  estimateLiquidationPrice,
  stopTooCloseToLiquidation,
  LIQUIDATION_BUFFER,
  MAINTENANCE_MARGIN_RATE,
} from "./futuresMath";
import { FUTURES_FEE_RATE, DEFAULT_FEE_RATE } from "./tradingCosts";

export type RiskModel = "percent" | "dollar";
export type DollarRiskSide = "long" | "short";

/** Everything the planner needs that does NOT depend on the entry price. */
export interface DollarRiskConfig {
  marketType: "spot" | "futures";
  /** Spot: notional per trade. Futures: MARGIN budget per trade. */
  tradeAmountUsdt: number;
  /** Futures leverage (1 for spot / no leverage). */
  leverage: number;
  /** Max dollars to lose on the trade (net of fees). */
  maxLossUsdt: number;
  /** Desired dollar profit on the trade (net of fees). */
  targetProfitUsdt: number;
  /** Taker fee fraction per leg. Defaults to the market's standard rate. */
  feeRate?: number;
}

/** Price-independent result — safe to compute in the browser for the preview. */
export interface DollarRiskFractions {
  notionalUsdt: number;
  marginUsdt: number;
  roundTripFeesUsdt: number;
  /** SL price distance as a fraction of entry (0.10 = 10%). */
  slFraction: number;
  tpFraction: number;
  slPercent: number;
  tpPercent: number;
  rewardRiskRatio: number;
  /** Futures only: fractional distance from entry to liquidation. null for spot / lev ≤ 1. */
  liquidationFraction: number | null;
  liquidationPercent: number | null;
  /** True when the stop sits safely inside the liquidation price (always true for spot). */
  safe: boolean;
  /** False when round-trip fees alone meet/exceed maxLossUsdt — the stop can't be placed. */
  feasible: boolean;
  warnings: string[];
  /** When unsafe/infeasible: a concrete fix (lower leverage / raise margin / raise max loss). */
  suggestion: string | null;
}

/** Full plan once an entry price is known — used by the engines at trade time. */
export interface DollarRiskPlan extends DollarRiskFractions {
  entryPrice: number;
  side: DollarRiskSide;
  qty: number;
  slPrice: number;
  tpPrice: number;
  liquidationPrice: number | null;
  expectedLossUsdt: number;
  expectedProfitUsdt: number;
}

function defaultFeeRate(marketType: "spot" | "futures"): number {
  return marketType === "futures" ? FUTURES_FEE_RATE : DEFAULT_FEE_RATE;
}

/**
 * Highest leverage (≥ 1) at which the stop still sits safely inside the
 * liquidation price for the given margin / max-loss. Used to suggest a fix when
 * the configured leverage is too high. Returns 1 in the worst case (spot-like:
 * no liquidation, always safe).
 */
export function maxSafeLeverage(cfg: DollarRiskConfig, mmr: number = MAINTENANCE_MARGIN_RATE): number {
  const feeRate = cfg.feeRate ?? defaultFeeRate(cfg.marketType);
  for (let lev = Math.max(1, Math.floor(cfg.leverage)); lev >= 1; lev--) {
    // Pass suggestChanges=false to avoid re-entering this scan (infinite loop).
    const f = planDollarRiskFractions({ ...cfg, marketType: "futures", leverage: lev, feeRate }, mmr, false);
    if (f.feasible && f.safe) return lev;
  }
  return 1;
}

/**
 * Price-independent core. Everything the Settings preview shows is derived here
 * so the browser and the server agree to the cent without a round-trip.
 *
 * `suggestChanges` (default true) controls whether an unsafe/futures plan scans
 * for a safe leverage to suggest — maxSafeLeverage() passes false to break the
 * mutual recursion between the two functions.
 */
export function planDollarRiskFractions(
  cfg: DollarRiskConfig,
  mmr: number = MAINTENANCE_MARGIN_RATE,
  suggestChanges: boolean = true,
): DollarRiskFractions {
  const isFutures = cfg.marketType === "futures";
  const leverage = isFutures ? Math.max(1, cfg.leverage) : 1;
  const feeRate = cfg.feeRate ?? defaultFeeRate(cfg.marketType);
  const margin = Math.max(0, cfg.tradeAmountUsdt);
  const notional = margin * (isFutures ? leverage : 1);

  const warnings: string[] = [];
  // Round-trip taker fees on the entry notional (entry + exit legs). This is an
  // estimate: the exit notional differs slightly as price moves, but the entry
  // basis is the honest, conservative figure to plan against.
  const roundTripFeesUsdt = notional * feeRate * 2;

  const maxLoss = Math.max(0, cfg.maxLossUsdt);
  const targetProfit = Math.max(0, cfg.targetProfitUsdt);

  // The stop must leave room to actually lose `maxLoss` NET of the fees you pay
  // on the way in and out. If fees already meet/exceed maxLoss, no stop can
  // honour the budget — the trade is infeasible as configured.
  const grossLoss = maxLoss - roundTripFeesUsdt;
  const grossGain = targetProfit + roundTripFeesUsdt;
  const feasible = notional > 0 && grossLoss > 0;

  if (notional <= 0) warnings.push("Trade amount (notional) is zero.");
  if (!feasible && notional > 0) {
    warnings.push(
      `Round-trip fees (~$${roundTripFeesUsdt.toFixed(2)}) meet or exceed your max loss ($${maxLoss.toFixed(2)}) — ` +
        `no stop can keep the loss that small. Increase max loss, or reduce trade amount/leverage.`,
    );
  }

  const slFraction = feasible ? grossLoss / notional : 0;
  const tpFraction = notional > 0 ? grossGain / notional : 0;
  const rewardRiskRatio = maxLoss > 0 ? targetProfit / maxLoss : 0;

  // Futures liquidation distance is purely a function of leverage (and mmr):
  // price moves (1/lev − mmr) against you to wipe the margin. Price-independent.
  let liquidationFraction: number | null = null;
  if (isFutures && leverage > 1) {
    liquidationFraction = Math.max(0, 1 / leverage - mmr);
  }

  // Safe when the liquidation distance clears the stop distance by the buffer.
  let safe = true;
  let suggestion: string | null = null;
  if (liquidationFraction !== null) {
    safe = feasible && liquidationFraction >= slFraction * LIQUIDATION_BUFFER;
    if (!safe && suggestChanges) {
      const safeLev = maxSafeLeverage(cfg, mmr);
      suggestion =
        safeLev < leverage
          ? `Stop would sit at/beyond liquidation. Reduce leverage to ${safeLev}× (or lower), ` +
            `raise the trade amount, or lower the max loss.`
          : `Stop would sit at/beyond liquidation. Lower the max loss or raise the trade amount.`;
      warnings.push(suggestion);
    }
  }

  return {
    notionalUsdt: notional,
    marginUsdt: margin,
    roundTripFeesUsdt,
    slFraction,
    tpFraction,
    slPercent: slFraction * 100,
    tpPercent: tpFraction * 100,
    rewardRiskRatio,
    liquidationFraction,
    liquidationPercent: liquidationFraction !== null ? liquidationFraction * 100 : null,
    safe,
    feasible,
    warnings,
    suggestion,
  };
}

/**
 * Full plan once the entry price is known. Live + backtest call this to size a
 * dollar-model trade and place the stop/target. `qty` is notional ÷ entry;
 * SL/TP prices are entry shifted by the price-independent fractions above.
 */
export function planDollarRisk(
  entryPrice: number,
  side: DollarRiskSide,
  cfg: DollarRiskConfig,
): DollarRiskPlan {
  const f = planDollarRiskFractions(cfg);
  const isShort = side === "short";
  const qty = entryPrice > 0 ? f.notionalUsdt / entryPrice : 0;

  const slPrice = isShort ? entryPrice * (1 + f.slFraction) : entryPrice * (1 - f.slFraction);
  const tpPrice = isShort ? entryPrice * (1 - f.tpFraction) : entryPrice * (1 + f.tpFraction);

  let liquidationPrice: number | null = null;
  if (f.liquidationFraction !== null && entryPrice > 0) {
    liquidationPrice = estimateLiquidationPrice(entryPrice, side, Math.max(1, cfg.leverage));
  }

  // Expected P&L NET of round-trip fees — by construction these equal the user's
  // configured max loss / target profit when feasible, but we compute them from
  // the actual qty/prices so the numbers are auditable, not just asserted.
  const grossLossAtSl = Math.abs(entryPrice - slPrice) * qty;
  const grossGainAtTp = Math.abs(tpPrice - entryPrice) * qty;
  const expectedLossUsdt = grossLossAtSl + f.roundTripFeesUsdt;
  const expectedProfitUsdt = grossGainAtTp - f.roundTripFeesUsdt;

  return {
    ...f,
    entryPrice,
    side,
    qty,
    slPrice,
    tpPrice,
    liquidationPrice,
    expectedLossUsdt,
    expectedProfitUsdt,
  };
}
