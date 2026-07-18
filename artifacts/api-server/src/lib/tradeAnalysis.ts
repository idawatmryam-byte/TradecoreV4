/**
 * TradeCore Pro — Post-trade analysis (evidence-based, deterministic)
 *
 * The moment a trade closes, this turns its RECORDED facts (entry/exit prices,
 * planned vs actual SL/TP/qty, exit reason, holding time, fees, slippage, risk
 * audit) into a structured explanation of WHY it turned out the way it did.
 *
 * Everything here is derived arithmetically from data the engine already wrote
 * to the trade row — there are NO assumptions, no market-condition guesses, and
 * nothing fabricated. If a fact wasn't recorded (e.g. live trades don't track
 * intra-trade max favourable/adverse excursion), the analysis simply doesn't
 * claim it. The grade is a scorecard of what *happened* (process quality), not
 * a prediction of the future.
 */
import type { Trade } from "@workspace/db";

export interface TradeAnalysisResult {
  outcome: "win" | "loss" | "breakeven";
  /** Realized reward:risk in R units (net P&L ÷ planned dollar risk), or null. */
  rMultiple: number | null;
  /** Process-quality grade A–F — reflects execution/risk/cost, not just win/loss. */
  grade: string;
  /** Itemised factual findings, one per analysed dimension. */
  findings: string[];
  /** One-paragraph readable explanation. */
  summary: string;
}

const n = (v: unknown): number => Number(v ?? 0);
const money = (v: number): string => `${v >= 0 ? "+" : "-"}$${Math.abs(v).toFixed(2)}`;

export function analyzeTrade(trade: Trade): TradeAnalysisResult {
  const netPnl = n(trade.pnl);
  const grossPnl = trade.grossPnl != null ? n(trade.grossPnl) : netPnl;
  const fees = n(trade.feesUsdt);
  const slippage = n(trade.slippageUsdt);
  const entry = n(trade.entryPrice);
  const exit = trade.exitPrice != null ? n(trade.exitPrice) : entry;
  const isShort = trade.side === "sell";
  const strat = trade.strategyName ?? trade.strategyId ?? "unknown strategy";
  const confidence = n(trade.confidence);
  const holdMin = trade.holdingSeconds != null ? n(trade.holdingSeconds) / 60 : null;
  const exitReason = trade.exitReason ?? "unknown";

  // Planned dollar risk = distance to the ORIGINAL planned stop × planned size.
  const plannedSl = trade.plannedStopLoss != null ? n(trade.plannedStopLoss) : n(trade.stopLoss);
  const plannedQty = trade.plannedQuantity != null ? n(trade.plannedQuantity) : n(trade.quantity);
  const plannedRisk = Math.abs(entry - plannedSl) * plannedQty;
  const rMultiple = plannedRisk > 0 ? netPnl / plannedRisk : null;

  const eps = Math.max(0.01, plannedRisk * 0.02);
  const outcome: TradeAnalysisResult["outcome"] =
    netPnl > eps ? "win" : netPnl < -eps ? "loss" : "breakeven";

  const findings: string[] = [];

  // ── 1. Outcome ─────────────────────────────────────────────────────────────
  findings.push(
    `Outcome: ${outcome.toUpperCase()} — net ${money(netPnl)}` +
      (rMultiple != null ? ` (${rMultiple >= 0 ? "+" : ""}${rMultiple.toFixed(2)}R)` : "") +
      ` on ${strat} (${isShort ? "short" : "long"} ${trade.symbol}).`,
  );

  // ── 2. Entry quality ───────────────────────────────────────────────────────
  findings.push(
    `Entry conviction: signalled at ${confidence.toFixed(0)}% confidence` +
      (plannedRisk > 0 ? `, risking $${plannedRisk.toFixed(2)} to the planned stop.` : "."),
  );

  // ── 3. Exit decision (the richest dimension) ───────────────────────────────
  let exitFinding: string;
  let exitInefficiency = false;
  switch (exitReason) {
    case "take_profit":
      exitFinding = "Exit: full take-profit reached — the target played out as planned.";
      break;
    case "stop_loss":
      exitFinding = "Exit: stopped out at the protective stop — risk was capped as designed.";
      break;
    case "trailing_stop":
      exitFinding = `Exit: trailing stop — a managed exit that locked in ${money(netPnl)} after the move extended.`;
      break;
    case "break_even":
      exitFinding = "Exit: break-even stop (moved to entry after TP1) — the trade was protected from turning into a loss.";
      break;
    case "timeout":
      exitInefficiency = outcome !== "win";
      exitFinding =
        `Exit: max holding time reached` +
        (holdMin != null ? ` (${holdMin.toFixed(0)}m)` : "") +
        ` without hitting stop or target — closed at market ${outcome === "win" ? "in profit" : "as it drifted"}.`;
      break;
    case "end_of_backtest":
      exitFinding = "Exit: position was still open when the run ended (not a real trading outcome).";
      break;
    default:
      exitFinding = `Exit: ${exitReason.replace(/_/g, " ")}.`;
  }
  if (trade.tp1Filled) exitFinding += " TP1 partial had already banked part of the position.";
  findings.push(exitFinding);

  // ── 4. Timing ──────────────────────────────────────────────────────────────
  if (holdMin != null) {
    findings.push(
      `Timing: held ${holdMin < 60 ? `${holdMin.toFixed(0)} min` : `${(holdMin / 60).toFixed(1)} h`}` +
        (exitReason === "timeout" ? " — the full holding window, so the thesis never resolved in time." : "."),
    );
  }

  // ── 5. Execution / cost drag ───────────────────────────────────────────────
  const totalCost = fees + slippage;
  const costPctOfGross = Math.abs(grossPnl) > 0 ? (totalCost / Math.abs(grossPnl)) * 100 : null;
  const heavyCost = costPctOfGross != null && costPctOfGross >= 30;
  findings.push(
    `Execution cost: fees ${money(-fees)} + slippage ${money(-slippage)} = ${money(-totalCost)}` +
      (costPctOfGross != null ? ` — ${costPctOfGross.toFixed(0)}% of the gross move${heavyCost ? " (heavy drag)" : ""}.` : "."),
  );

  // ── 6. Risk management ─────────────────────────────────────────────────────
  if (trade.riskViolation) {
    findings.push(
      `⚠ Risk audit: the realized loss EXCEEDED the expected maximum${trade.riskViolationReason ? ` — ${trade.riskViolationReason}` : ""}.`,
    );
  } else {
    findings.push(
      `Risk audit: loss stayed within the planned maximum` +
        (trade.breakEvenActive ? "; stop had been moved to break-even" : "") +
        (trade.trailingStopActive ? "; a trailing stop was managing the exit" : "") +
        ".",
    );
  }

  // ── 7. Plan vs. actual (decision engine) ───────────────────────────────────
  // When the trade carries its full TradePlan, hold the strategy accountable
  // to its own written assumptions — still purely arithmetic on recorded data.
  const plan = trade.tradePlan as
    | { expectedHoldSeconds?: number; leverage?: number; report?: { summary?: string } }
    | null;
  if (plan && typeof plan === "object") {
    const expectedHold = n(plan.expectedHoldSeconds);
    if (expectedHold > 0 && trade.holdingSeconds != null) {
      const actualHold = n(trade.holdingSeconds);
      const ratio = actualHold / expectedHold;
      if (exitReason === "take_profit" && ratio <= 1.2) {
        findings.push(
          `Plan accuracy: thesis resolved in ${(actualHold / 60).toFixed(0)}m vs ~${(expectedHold / 60).toFixed(0)}m expected — the duration estimate held up.`,
        );
      } else if (ratio > 2) {
        findings.push(
          `Plan accuracy: held ${(actualHold / 60).toFixed(0)}m vs ~${(expectedHold / 60).toFixed(0)}m expected (${ratio.toFixed(1)}×) — the move was much slower than the plan assumed.`,
        );
      } else if (ratio < 0.25 && outcome === "loss") {
        findings.push(
          `Plan accuracy: stopped out after ${(actualHold / 60).toFixed(0)}m vs ~${(expectedHold / 60).toFixed(0)}m expected — invalidated almost immediately, the entry timing assumption was wrong.`,
        );
      }
    }
    const plannedLev = n(trade.plannedLeverage ?? plan.leverage);
    const actualLev = n(trade.leverage);
    if (plannedLev > 0 && actualLev > 0 && actualLev < plannedLev) {
      findings.push(
        `Plan deviation: planned ${plannedLev}× leverage but the exchange applied ${actualLev}× (symbol cap) — size was scaled down to keep margin within budget.`,
      );
    }
  }

  // ── Process-quality grade (A–F) ────────────────────────────────────────────
  // Scores the RECORDED process, not luck. A cleanly-stopped loss is not an F.
  let score = 3; // C baseline
  if (rMultiple != null) {
    if (rMultiple >= 2) score += 2;
    else if (rMultiple >= 1) score += 1;
    else if (rMultiple <= -1) score -= 1; // took the full planned loss or worse
  }
  if (exitReason === "take_profit") score += 1;         // target reached
  if (exitInefficiency) score -= 1;                     // drifted into a timeout loss
  if (heavyCost) score -= 1;                            // costs ate the edge
  if (trade.riskViolation) score -= 3;                  // the cardinal sin
  const grade = ["F", "F", "D", "C", "B", "A", "A"][Math.max(0, Math.min(6, score))]!;

  // ── Readable summary ───────────────────────────────────────────────────────
  const rTxt = rMultiple != null ? `${rMultiple >= 0 ? "+" : ""}${rMultiple.toFixed(2)}R` : "n/a";
  const summary =
    `This ${isShort ? "short" : "long"} on ${trade.symbol} (${strat}) closed a ${outcome} of ${money(netPnl)} (${rTxt}), ` +
    `exiting via ${exitReason.replace(/_/g, " ")}` +
    (holdMin != null ? ` after ${holdMin < 60 ? `${holdMin.toFixed(0)}m` : `${(holdMin / 60).toFixed(1)}h`}` : "") +
    `. ` +
    (trade.riskViolation
      ? "Risk control FAILED — the loss exceeded the planned maximum, the most important thing to fix. "
      : "Risk was contained within plan. ") +
    (heavyCost ? "Trading costs took a large share of the move. " : "") +
    (exitInefficiency ? "It ran out of time rather than resolving, suggesting the target/holding window may be mismatched. " : "") +
    `Process grade: ${grade}.`;

  return { outcome, rMultiple, grade, findings, summary };
}
