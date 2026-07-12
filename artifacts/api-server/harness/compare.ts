/**
 * TradeCore Pro — Backtest-Validation Harness: snapshot comparison
 *
 * Diffs two metric snapshots produced by run.ts so you can judge whether a
 * one-variable code change helped or hurt on the SAME deterministic dataset.
 *
 * Usage:
 *   tsx harness/compare.ts <baselineLabel> <variantLabel>
 *   e.g. tsx harness/compare.ts baseline unified-confidence
 *
 * Reminder: on synthetic data only the DELTA is meaningful, never the
 * absolute numbers. A change is "better" if it improves the metrics in the
 * direction marked below AND doesn't quietly wreck another (e.g. a higher
 * win rate bought with a much worse profit factor or drawdown is not a win).
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const RESULTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "results");

// metric key → higher-is-better?  (null = neutral, just show the delta)
const DIRECTION: Record<string, boolean | null> = {
  totalTrades: null,
  winRate: true,
  totalPnl: true,
  totalReturn: true,
  profitFactor: true,
  expectancy: true,
  sharpeRatio: true,
  sortinoRatio: true,
  maxDrawdown: false, // lower is better
  averageWin: true,
  averageLoss: true, // less-negative is better → higher is better
  tp1HitRate: null,
  tp2HitRate: null,
  breakEvenRate: null,
  trailingStopRate: null,
};

function load(label: string): any {
  try {
    return JSON.parse(readFileSync(join(RESULTS_DIR, `${label}.json`), "utf8"));
  } catch {
    throw new Error(`No snapshot "${label}.json" in ${RESULTS_DIR} — run: tsx harness/run.ts --label ${label}`);
  }
}

function fmt(v: number | null): string {
  if (v == null) return "—";
  return Math.abs(v) < 1 && v !== 0 ? v.toFixed(4) : v.toFixed(2);
}

function main() {
  const [aLabel, bLabel] = process.argv.slice(2);
  if (!aLabel || !bLabel) throw new Error("usage: tsx harness/compare.ts <baseline> <variant>");

  const a = load(aLabel);
  const b = load(bLabel);

  console.log(`\n  Comparing  ${aLabel}  →  ${bLabel}`);
  console.log(`  (same dataset: ${a.window.symbols.join(",")} · ${a.window.start} → ${a.window.end})\n`);

  const col = (s: string, w: number) => s.padStart(w);
  console.log(`  ${"metric".padEnd(18)}${col(aLabel, 14)}${col(bLabel, 14)}${col("Δ", 14)}   verdict`);
  console.log(`  ${"-".repeat(18 + 14 * 3 + 12)}`);

  for (const key of Object.keys(DIRECTION)) {
    const av = a.metrics[key] as number | null;
    const bv = b.metrics[key] as number | null;
    if (av == null && bv == null) continue;
    const delta = av != null && bv != null ? bv - av : null;

    let verdict = "";
    const dir = DIRECTION[key];
    if (delta != null && dir != null && Math.abs(delta) > 1e-9) {
      const improved = dir ? delta > 0 : delta < 0;
      verdict = improved ? "✓ better" : "✗ worse";
    } else if (delta != null && Math.abs(delta) <= 1e-9) {
      verdict = "= same";
    }
    console.log(`  ${key.padEnd(18)}${col(fmt(av), 14)}${col(fmt(bv), 14)}${col(fmt(delta), 14)}   ${verdict}`);
  }

  console.log(`\n  exit reasons`);
  console.log(`    ${aLabel}: ${JSON.stringify(a.exitReasons)}`);
  console.log(`    ${bLabel}: ${JSON.stringify(b.exitReasons)}`);
  console.log(`  sides`);
  console.log(`    ${aLabel}: ${JSON.stringify(a.sides)}`);
  console.log(`    ${bLabel}: ${JSON.stringify(b.sides)}\n`);
}

main();
