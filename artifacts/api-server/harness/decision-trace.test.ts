/**
 * DECISION TRACE test — the Co-Pilot workspace's timeline is only honest if
 * it renders the pipeline's own finalized stages, never a narrative
 * reconstruction of them.
 *
 * Pins two things that would be easy to get subtly wrong:
 *   1. `buildDecisionTrace` carries the four finalized stages through verbatim
 *      and appends a fifth "Order" stage that always PASSES — reaching this
 *      call already means Market Data/Indicators/Signal/Risk Checks all
 *      passed, so a Co-Pilot recommendation can never show a failing Order
 *      stage.
 *   2. `relabelTraceForModification` keeps the still-honest market context
 *      from the parent but replaces the Order stage's wording to attribute
 *      the plan to the user, not the strategy — and never leaves two Order
 *      rows in the trace.
 *
 * Pure — no DB, no exchange.
 *
 * Run:  tsx harness/decision-trace.test.ts   (exit 0 = pass)
 */
import { buildDecisionTrace, relabelTraceForModification } from "../src/lib/execution/recommendExecutor";
import type { PipelineStage } from "../src/lib/decisionTrace";

let failures = 0;
function expect(name: string, cond: boolean, detail = "") {
  if (!cond) {
    failures++;
    console.error(`✗  ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    console.log(`✓  ${name}`);
  }
}

const NOW = new Date("2025-06-01T12:00:00Z");

const FOUR_STAGES: PipelineStage[] = [
  { name: "Market Data", status: "pass", detail: "candles fresh" },
  { name: "Indicators", status: "pass", detail: "RSI 62" },
  { name: "Signal", status: "pass", detail: "trend pullback triggered" },
  { name: "Risk Checks", status: "pass", detail: "within daily loss limit" },
];

// ── buildDecisionTrace ───────────────────────────────────────────────────────
{
  const trace = buildDecisionTrace(FOUR_STAGES, NOW);
  expect("carries all four preceding stages through", trace.length === 5, String(trace.length));
  expect("preceding stages are unchanged", FOUR_STAGES.every((s, i) => trace[i] === s));
  const order = trace[4]!;
  expect("appends an Order stage last", order.name === "Order");
  expect("the Order stage always passes", order.status === "pass", order.status);
  expect("the Order detail names Co-Pilot, not the strategy", /Co-Pilot/.test(order.detail), order.detail);
}

{
  const trace = buildDecisionTrace(undefined, NOW);
  expect("tolerates missing preceding stages (direct executor call, no scan context)", trace.length === 1, String(trace.length));
  expect("still produces a passing Order stage", trace[0]!.status === "pass");
}

// ── relabelTraceForModification ─────────────────────────────────────────────
{
  const parent = buildDecisionTrace(FOUR_STAGES, NOW);
  const relabeled = relabelTraceForModification(parent, NOW);
  expect("keeps exactly one Order stage, not two", relabeled.filter((s) => s.name === "Order").length === 1, String(relabeled.length));
  expect("keeps the four market-context stages", relabeled.length === 5, String(relabeled.length));
  expect("market-context stages carry over verbatim", FOUR_STAGES.every((s, i) => relabeled[i] === s));
  const order = relabeled[4]!;
  expect("the new Order stage attributes the plan to the user", /User-modified/.test(order.detail), order.detail);
  expect("the modified Order stage still passes", order.status === "pass");
}

{
  const relabeled = relabelTraceForModification(null, NOW);
  expect("tolerates a null parent trace", relabeled.length === 1, String(relabeled.length));
  expect("still produces exactly one Order stage", relabeled[0]!.name === "Order");
}

console.log(failures === 0 ? "\nAll decision-trace checks passed." : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
