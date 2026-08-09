/**
 * REVALIDATE test — the checks between an approved plan and real money.
 *
 * Approving a Co-Pilot plan does not mean "place this order". It means
 * "re-ask the risk engine, right now". Skip that and Co-Pilot becomes
 * strictly MORE dangerous than AutoPilot: the same trade, taken minutes
 * later, with none of the gates re-run.
 *
 * Every branch is pinned here because each one is a way real money escapes.
 *
 * Pure — no DB, no exchange.
 *
 * Run:  tsx harness/revalidate.test.ts   (exit 0 = pass)
 */
import { revalidate, MAX_ENTRY_DRIFT_R, type RevalidationInputs } from "../src/lib/execution/revalidate";

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

/** A plan that should sail through, so each case below changes exactly one thing. */
function healthy(over: Partial<RevalidationInputs> = {}): RevalidationInputs {
  return {
    plan: { symbol: "BTCUSDT", side: "long", strategyId: "trend_pullback", entryPrice: 100, slPrice: 95, qty: 1 },
    expiresAt: new Date(NOW.getTime() + 5 * 60_000),
    status: "created",
    now: NOW,
    currentPrice: 100,
    engineRunning: true,
    circuitBreakerActive: false,
    riskPaused: false,
    openPositions: 1,
    maxOpenPositions: 5,
    strategyOpenCount: 0,
    maxConcurrentPerStrategy: 2,
    openRiskUsdt: 10,
    maxPortfolioRiskUsdt: 100,
    onCooldown: false,
    blacklisted: false,
    symbolAlreadyOpen: false,
    ...over,
  };
}

// ── The happy path ──────────────────────────────────────────────────────────
{
  const r = revalidate(healthy());
  expect("an unchanged situation still approves", r.ok, r.reason);
  expect("every check is reported, not just failures", r.checks.length >= 11, String(r.checks.length));
  expect("all checks pass", r.checks.every((c) => c.passed));
}

// ── Each gate refuses on its own ────────────────────────────────────────────
const cases: Array<[string, Partial<RevalidationInputs>, string]> = [
  ["expiry", { expiresAt: new Date(NOW.getTime() - 1) }, "EXPIRED"],
  ["a plan already acted on", { status: "executed" }, "NOT_ACTIONABLE"],
  ["a stopped engine", { engineRunning: false }, "ENGINE_STOPPED"],
  ["the daily-loss circuit breaker", { circuitBreakerActive: true }, "CIRCUIT_BREAKER"],
  ["a risk pause", { riskPaused: true }, "RISK_PAUSED"],
  ["max open positions", { openPositions: 5, maxOpenPositions: 5 }, "MAX_POSITIONS"],
  ["per-strategy concurrency", { strategyOpenCount: 2, maxConcurrentPerStrategy: 2 }, "STRATEGY_CONCURRENCY"],
  ["a position already open on the symbol", { symbolAlreadyOpen: true }, "ALREADY_OPEN"],
  ["a symbol cooldown", { onCooldown: true }, "SYMBOL_COOLDOWN"],
  ["a blacklisted symbol", { blacklisted: true }, "BLACKLISTED"],
  ["the portfolio risk cap", { openRiskUsdt: 98, maxPortfolioRiskUsdt: 100 }, "PORTFOLIO_RISK"],
];
for (const [what, patch, code] of cases) {
  const r = revalidate(healthy(patch));
  expect(`${what} refuses approval`, !r.ok && r.code === code, `${r.code ?? "approved"}`);
  expect(`${what} explains itself in prose`, !!r.reason && r.reason.length > 20, r.reason ?? "");
}

// Boundary: exactly at the cap is still allowed; a hair over is not.
{
  // candidate risk = |100-95| × 1 = 5
  expect("exactly at the portfolio cap is allowed", revalidate(healthy({ openRiskUsdt: 95, maxPortfolioRiskUsdt: 100 })).ok);
  expect("a hair over the cap is refused", !revalidate(healthy({ openRiskUsdt: 95.01, maxPortfolioRiskUsdt: 100 })).ok);
}
{
  expect("one slot free is allowed", revalidate(healthy({ openPositions: 4, maxOpenPositions: 5 })).ok);
  expect("expiring exactly now is refused", !revalidate(healthy({ expiresAt: NOW })).ok);
}

// ── Price drift, measured in the plan's own R ───────────────────────────────
// Tying tolerance to the plan's geometry is the point: 0.3% is nothing for a
// wide swing stop and most of the budget for a tight scalp.
{
  const riskDistance = 5; // 100 → 95
  const justInside = 100 + riskDistance * (MAX_ENTRY_DRIFT_R - 0.01);
  const justOutside = 100 + riskDistance * (MAX_ENTRY_DRIFT_R + 0.01);
  expect("a small drift is tolerated", revalidate(healthy({ currentPrice: justInside })).ok);
  const drifted = revalidate(healthy({ currentPrice: justOutside }));
  expect("drift beyond the tolerance refuses", !drifted.ok && drifted.code === "PRICE_DRIFT", String(drifted.code));
  expect("drift refusal quantifies the move in R", /R/.test(drifted.reason ?? ""), drifted.reason ?? "");
  expect("drift is symmetric — moving against the plan also refuses",
    !revalidate(healthy({ currentPrice: 100 - riskDistance * (MAX_ENTRY_DRIFT_R + 0.01) })).ok);

  // A tight stop makes the SAME absolute move intolerable — the whole reason
  // the tolerance is expressed in R rather than percent.
  const tight = healthy({
    plan: { symbol: "BTCUSDT", side: "long", strategyId: "s", entryPrice: 100, slPrice: 99.5, qty: 1 },
    currentPrice: 100.5,
  });
  expect("the same drift refuses when the stop is tight", !revalidate(tight).ok);
  const wide = healthy({
    plan: { symbol: "BTCUSDT", side: "long", strategyId: "s", entryPrice: 100, slPrice: 90, qty: 1 },
    currentPrice: 100.5,
  });
  expect("...and is fine when the stop is wide", revalidate(wide).ok);
}

// An unavailable price is not proof of safety. Approval must fail closed
// because the plan's defining entry geometry cannot be re-checked.
{
  const r = revalidate(healthy({ currentPrice: undefined }));
  expect("an unobtainable price blocks approval", !r.ok && r.code === "PRICE_UNAVAILABLE", r.reason);
  const check = r.checks.find((c) => c.name === "Price still near the plan");
  expect("...and reports the unavailable price as failed", check?.passed === false && /unavailable/.test(check.detail), check?.detail ?? "");
}

// ── Reporting: the user sees the whole picture ──────────────────────────────
{
  const r = revalidate(healthy({ circuitBreakerActive: true, blacklisted: true, riskPaused: true }));
  expect("multiple failures still report every check", r.checks.length >= 11);
  expect("the first failure in evaluation order is the headline", r.code === "CIRCUIT_BREAKER", String(r.code));
  expect("all three failures are visible in the checks", r.checks.filter((c) => !c.passed).length === 3,
    String(r.checks.filter((c) => !c.passed).length));
}

console.log(failures === 0 ? "\nAll revalidation checks passed." : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
