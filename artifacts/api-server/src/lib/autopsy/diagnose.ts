/**
 * TradeCore Pro — Optimization Autopsy: diagnosis generation (pure, tested)
 *
 * Turns the sweep's measured numbers into the plain-English report. Two hard
 * rules keep this honest:
 *
 *   1. Every claim is computed from MEASURED backtest data (win rates, exit-
 *      reason distributions, trade counts) — never a templated guess.
 *   2. "no_better" and "insufficient_data" are first-class verdicts. A
 *      suggestion only exists when a candidate beat the current config on
 *      the VALIDATION window it was never fitted to; telling the user their
 *      config is not the problem is a valid, useful diagnosis.
 */

/** The tunable knobs the autopsy sweeps (the strategy's REAL live surface). */
export interface AutopsyParams {
  maxLossUsdt: number | null;
  targetProfitUsdt: number | null;
  confidenceThreshold: number;
  maxHoldingSeconds: number;
}

/** Window metrics summary harvested from a completed child backtest run. */
export interface WindowMetrics {
  totalTrades: number;
  winRate: number;        // 0..1
  profitFactor: number;
  sharpeRatio: number;
  maxDrawdown: number;    // fraction
  totalPnl: number;
  /** exitReason → count, from the run's trades. */
  exitReasons: Record<string, number>;
}

export interface AutopsyFinding {
  param: keyof AutopsyParams;
  /** Human label as it appears on the Strategies page. */
  label: string;
  current: number | null;
  suggested: number | null;
  /** Measured, number-backed explanation. */
  evidence: string;
  /** What to change, in UI terms. */
  action: string;
}

export interface AutopsyDiagnosis {
  verdict: "improved" | "no_better" | "insufficient_data";
  summary: string;
  findings: AutopsyFinding[];
}

export const MIN_TRADES_FOR_VERDICT = 10;
/** A candidate must beat current PF by ≥5% out-of-sample to count — smaller
 *  gaps are indistinguishable from noise at these trade counts. */
export const MIN_PF_EDGE = 1.05;

const PARAM_LABELS: Record<keyof AutopsyParams, string> = {
  maxLossUsdt: "Max Loss per trade ($)",
  targetProfitUsdt: "Target Profit per trade ($)",
  confidenceThreshold: "Confidence Threshold",
  maxHoldingSeconds: "Max Holding Time",
};

const fmtPct = (x: number) => `${(x * 100).toFixed(0)}%`;
const fmtPf = (x: number) => (x >= 999 ? "∞" : x.toFixed(2));
const fmtHold = (s: number) => (s % 3600 === 0 ? `${s / 3600}h` : `${Math.round(s / 60)}min`);

function share(m: WindowMetrics, reason: string): number {
  const total = Object.values(m.exitReasons).reduce((a, b) => a + b, 0);
  return total > 0 ? (m.exitReasons[reason] ?? 0) / total : 0;
}

/**
 * Build the per-parameter evidence line from measured window data. Only
 * parameters that actually changed produce findings, ordered by relative
 * change (the biggest mover — the "killer parameter" — first).
 */
export function buildFindings(
  current: AutopsyParams,
  best: AutopsyParams,
  currentVal: WindowMetrics,
  bestVal: WindowMetrics,
): AutopsyFinding[] {
  const findings: AutopsyFinding[] = [];

  const deltas: Array<{ key: keyof AutopsyParams; rel: number }> = [];
  for (const key of Object.keys(PARAM_LABELS) as Array<keyof AutopsyParams>) {
    const c = current[key];
    const b = best[key];
    if (c == null || b == null || c === b) continue;
    deltas.push({ key, rel: Math.abs(b - c) / Math.max(Math.abs(c), 1e-9) });
  }
  deltas.sort((a, b) => b.rel - a.rel);

  for (const { key } of deltas) {
    const c = current[key]!;
    const b = best[key]!;
    let evidence = "";
    let action = "";

    switch (key) {
      case "maxLossUsdt": {
        const stopShare = share(currentVal, "stop_loss");
        evidence =
          b > c
            ? `With your $${c} Max Loss, ${fmtPct(stopShare)} of the validation window's exits were stop-outs. Widening risk to $${b} per trade cut stop-outs to ${fmtPct(share(bestVal, "stop_loss"))} and lifted win rate ${fmtPct(currentVal.winRate)} → ${fmtPct(bestVal.winRate)}.`
            : `Your $${c} Max Loss risks more per trade than this strategy's edge supports here — tightening to $${b} improved profit factor ${fmtPf(currentVal.profitFactor)} → ${fmtPf(bestVal.profitFactor)} with drawdown ${fmtPct(currentVal.maxDrawdown)} → ${fmtPct(bestVal.maxDrawdown)}.`;
        action = `Set "${PARAM_LABELS.maxLossUsdt}" to ${b} on the Strategies page.`;
        break;
      }
      case "targetProfitUsdt": {
        const tpShare = share(currentVal, "take_profit");
        evidence =
          b < c
            ? `Your $${c} target was rarely reached — only ${fmtPct(tpShare)} of validation exits were take-profits. A $${b} target converted more moves into wins (take-profit exits ${fmtPct(tpShare)} → ${fmtPct(share(bestVal, "take_profit"))}, win rate ${fmtPct(currentVal.winRate)} → ${fmtPct(bestVal.winRate)}).`
            : `Your $${c} target sells winners too early for this window — stretching to $${b} improved profit factor ${fmtPf(currentVal.profitFactor)} → ${fmtPf(bestVal.profitFactor)}.`;
        action = `Set "${PARAM_LABELS.targetProfitUsdt}" to ${b} on the Strategies page.`;
        break;
      }
      case "confidenceThreshold": {
        evidence =
          b > c
            ? `At confidence ≥${c} the strategy took ${currentVal.totalTrades} validation trades at ${fmtPct(currentVal.winRate)} win rate; requiring ≥${b} kept the better ${bestVal.totalTrades} of them and won ${fmtPct(bestVal.winRate)}.`
            : `Confidence ≥${c} filtered too hard — lowering to ≥${b} took ${bestVal.totalTrades} trades (vs ${currentVal.totalTrades}) and still improved profit factor ${fmtPf(currentVal.profitFactor)} → ${fmtPf(bestVal.profitFactor)}.`;
        action = `Set "${PARAM_LABELS.confidenceThreshold}" to ${b} on the Strategies page.`;
        break;
      }
      case "maxHoldingSeconds": {
        const timeoutShare = share(currentVal, "timeout");
        evidence =
          b > c
            ? `${fmtPct(timeoutShare)} of validation exits hit the ${fmtHold(c)} time limit before resolving. Allowing ${fmtHold(b)} let trades reach their targets (timeouts ${fmtPct(timeoutShare)} → ${fmtPct(share(bestVal, "timeout"))}).`
            : `Holding up to ${fmtHold(c)} kept losers alive too long — capping at ${fmtHold(b)} improved profit factor ${fmtPf(currentVal.profitFactor)} → ${fmtPf(bestVal.profitFactor)}.`;
        action = `Set "${PARAM_LABELS.maxHoldingSeconds}" to ${fmtHold(b)} on the Strategies page.`;
        break;
      }
    }

    findings.push({ param: key, label: PARAM_LABELS[key], current: c, suggested: b, evidence, action });
  }

  return findings;
}

/**
 * The full verdict. `best*` are null when NO candidate survived validation.
 */
export function diagnose(
  current: AutopsyParams,
  currentVal: WindowMetrics | null,
  best: AutopsyParams | null,
  bestVal: WindowMetrics | null,
): AutopsyDiagnosis {
  if (!currentVal || currentVal.totalTrades < MIN_TRADES_FOR_VERDICT) {
    return {
      verdict: "insufficient_data",
      summary:
        `The current configuration produced only ${currentVal?.totalTrades ?? 0} trades on the validation window — ` +
        `below the ${MIN_TRADES_FOR_VERDICT}-trade minimum for a statistically meaningful comparison. ` +
        `Widen the date range or add symbols and re-run.`,
      findings: [],
    };
  }

  if (!best || !bestVal || bestVal.profitFactor < currentVal.profitFactor * MIN_PF_EDGE) {
    return {
      verdict: "no_better",
      summary:
        `No parameter change survived out-of-sample validation: candidates that looked better on the training window ` +
        `did not beat your current configuration (PF ${fmtPf(currentVal.profitFactor)}, win rate ${fmtPct(currentVal.winRate)}) ` +
        `on data they weren't fitted to. Your settings are not the problem — if results are still poor, the limitation is ` +
        `the strategy's edge in this market, not its tuning.`,
      findings: [],
    };
  }

  const findings = buildFindings(current, best, currentVal, bestVal);
  const killer = findings[0];
  return {
    verdict: "improved",
    summary:
      (killer ? `Killer parameter: ${killer.label}. ` : "") +
      `On the validation window (never used for fitting), the suggested configuration scored PF ${fmtPf(bestVal.profitFactor)} ` +
      `vs your current ${fmtPf(currentVal.profitFactor)}, win rate ${fmtPct(bestVal.winRate)} vs ${fmtPct(currentVal.winRate)}, ` +
      `across ${bestVal.totalTrades} trades. Historical improvement is evidence, not a guarantee — apply, then verify on paper trading.`,
    findings,
  };
}

/**
 * Staged candidate grids around the current values (coordinate descent:
 * stage 1 sweeps the dollar plan, stage 2 sweeps confidence × hold around
 * the stage-1 winner). Bounded so a full autopsy stays ≈ 25 backtests.
 */
export function dollarPlanGrid(current: AutopsyParams): AutopsyParams[] {
  const loss = current.maxLossUsdt ?? 10;
  const target = current.targetProfitUsdt ?? 20;
  const out: AutopsyParams[] = [];
  for (const lossMult of [0.5, 1, 1.5, 2]) {
    for (const targetMult of [0.5, 1, 1.5, 2.5]) {
      if (lossMult === 1 && targetMult === 1) continue; // that's "current"
      out.push({
        ...current,
        maxLossUsdt: round2(loss * lossMult),
        targetProfitUsdt: round2(target * targetMult),
      });
    }
  }
  return out;
}

export function timingGrid(base: AutopsyParams): AutopsyParams[] {
  const out: AutopsyParams[] = [];
  const confs = [...new Set([
    Math.max(0, base.confidenceThreshold - 10),
    base.confidenceThreshold,
    Math.min(95, base.confidenceThreshold + 10),
  ])];
  const holds = [...new Set([
    Math.max(300, Math.round(base.maxHoldingSeconds * 0.5)),
    base.maxHoldingSeconds,
    base.maxHoldingSeconds * 2,
  ])];
  for (const confidenceThreshold of confs) {
    for (const maxHoldingSeconds of holds) {
      if (confidenceThreshold === base.confidenceThreshold && maxHoldingSeconds === base.maxHoldingSeconds) continue;
      out.push({ ...base, confidenceThreshold, maxHoldingSeconds });
    }
  }
  return out;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
