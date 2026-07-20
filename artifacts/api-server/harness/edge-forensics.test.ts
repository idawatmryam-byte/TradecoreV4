/**
 * Offline verification for lib/edgeForensics.ts — the classification rules
 * (win/loss/scratch), R-multiple math, cell aggregation, and the verdicts
 * that turn a "10% win rate" into named leaks.
 *
 * Run:  tsx harness/edge-forensics.test.ts   (exit 0 = all pass)
 */
import { analyzeEdge, classifyTrade, realizedR, type ForensicTradeRow } from "../src/lib/edgeForensics";

let failures = 0;
function expect(name: string, actual: unknown, wanted: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(wanted);
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗ FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(actual)}, wanted ${JSON.stringify(wanted)})`}`);
}

function trade(over: Partial<ForensicTradeRow>): ForensicTradeRow {
  return {
    pnl: -10, grossPnl: null, feesUsdt: 0.5,
    entryPrice: 100, plannedStopLoss: 99, stopLoss: 99,
    plannedQuantity: 10, quantity: 10, // planned risk = $10
    exitReason: "stop_loss", strategyId: "mean_reversion", strategyName: "Mean Reversion",
    symbol: "BTCUSDT", entryTimeMs: Date.UTC(2026, 6, 15, 14, 30), holdingSeconds: 600, tp1Filled: false,
    ...over,
  };
}

// ── Classification rules ────────────────────────────────────────────────────
expect("full stop-out is a loss", classifyTrade(trade({ pnl: -10 })), "loss");
expect("profitable exit is a win", classifyTrade(trade({ pnl: 15, exitReason: "take_profit" })), "win");
expect("break_even exit is a SCRATCH even at small negative pnl", classifyTrade(trade({ pnl: -0.4, exitReason: "break_even" })), "scratch");
expect("tiny pnl within 10% of risk is a scratch", classifyTrade(trade({ pnl: -0.9, exitReason: "trailing_stop" })), "scratch");
expect("pnl just past the scratch band is a loss", classifyTrade(trade({ pnl: -1.5, exitReason: "trailing_stop" })), "loss");
expect("small positive within band is a scratch (not a win)", classifyTrade(trade({ pnl: 0.5, exitReason: "timeout" })), "scratch");

// ── R-multiple math: pnl / (|entry − planned stop| × planned qty) ──────────
expect("full loss ≈ −1R", realizedR(trade({ pnl: -10 })), -1);
expect("2× reward = +2R", realizedR(trade({ pnl: 20 })), 2);
// Planned stop wins over the (moved) live stop: BE move must not zero the risk.
expect("planned stop beats moved stop", realizedR(trade({ pnl: -10, stopLoss: 100, plannedStopLoss: 99 })), -1);
expect("degenerate stop → null R", realizedR(trade({ plannedStopLoss: 100, stopLoss: 100 })), null);

// ── The 10%-win-rate scenario: mostly scratches + noise stops ───────────────
const rows: ForensicTradeRow[] = [
  // 2 real wins
  trade({ pnl: 18, exitReason: "take_profit" }),
  trade({ pnl: 12, exitReason: "take_profit", symbol: "ETHUSDT" }),
  // 8 break-even scratches (the win-rate destroyer)
  ...Array.from({ length: 8 }, (_, i) => trade({ pnl: -0.3, exitReason: "break_even", entryTimeMs: Date.UTC(2026, 6, 15, 9 + i) })),
  // 6 fast noise stop-outs (< 5 min)
  ...Array.from({ length: 6 }, () => trade({ pnl: -10, exitReason: "stop_loss", holdingSeconds: 120 })),
  // 4 timeout bleeds
  ...Array.from({ length: 4 }, () => trade({ pnl: -4, exitReason: "timeout", symbol: "ETHUSDT" })),
];
const rep = analyzeEdge(rows);

expect("total trades", rep.totalTrades, 20);
expect("raw win rate is the scary 10%", rep.rawWinRate, 0.1);
// 2 wins / (20 − 8 scratches) = 16.7% — still bad, but a different diagnosis.
expect("adjusted win rate excludes scratches", rep.adjustedWinRate, 0.1667);
expect("scratches counted", rep.scratches, 8);
expect("losses counted", rep.losses, 10);

const critical = rep.verdicts.filter((v) => v.severity === "critical");
expect("scratch-miscount verdict fires", critical.some((v) => v.title.includes("scratches")), true);
expect("fast noise-stop verdict fires", critical.some((v) => v.title.includes("under 5 minutes")), true);

const stopCell = rep.byExitReason.find((c) => c.key === "stop_loss")!;
expect("stop_loss cell is the most bleeding (sorted first)", rep.byExitReason[0]!.key, "stop_loss");
expect("stop_loss avg R ≈ −1", stopCell.avgR, -1);

const eth = rep.bySymbol.find((c) => c.key === "ETHUSDT")!;
expect("symbol cell aggregates wins+timeouts", eth.trades, 5);
expect("hour cells use ENTRY hour", rep.byHourUtc.some((c) => c.key === "09"), true);

// ── Empty input stays calm ──────────────────────────────────────────────────
const empty = analyzeEdge([]);
expect("empty → no win rate", empty.rawWinRate, null);
expect("empty → info verdict only", empty.verdicts.map((v) => v.severity), ["info"]);

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll edge-forensics checks passed.");
