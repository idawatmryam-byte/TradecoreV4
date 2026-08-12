import { db, autopilotDecisionClaimsTable, tradesTable } from "@workspace/db";
import { and, count, eq, sql } from "drizzle-orm";
import { sha256Fingerprint } from "../intelligence/canonical";
import { getAutopilotSnapshot } from "./store";

export async function buildForwardSoakReport(userId: number, section: "crypto" | "forex") {
  const snapshot = await getAutopilotSnapshot(userId, section);
  if (!snapshot.mandate || !snapshot.mandateState) {
    return {
      status: "UNAVAILABLE" as const,
      reason: "No immutable Demo Autopilot mandate is selected",
      generatedAt: new Date().toISOString(),
      reportFingerprint: null,
    };
  }
  const scope = and(
    eq(autopilotDecisionClaimsTable.userId, userId),
    eq(autopilotDecisionClaimsTable.section, section),
    eq(autopilotDecisionClaimsTable.mandateId, snapshot.mandate.id),
  );
  const tradeScope = and(
    eq(tradesTable.userId, userId),
    eq(tradesTable.section, section),
    eq(tradesTable.autopilotMandateId, snapshot.mandate.id),
  );
  const regimeExpression = sql<string>`coalesce(${tradesTable.tradePlan}->>'regime', 'unavailable')`;
  const [claimCounts, tradeTotals, regimeRows] = await Promise.all([
    db.select({ status: autopilotDecisionClaimsTable.status, value: count() })
      .from(autopilotDecisionClaimsTable).where(scope).groupBy(autopilotDecisionClaimsTable.status),
    db.select({
      trades: sql<number>`count(*)::int`,
      openTrades: sql<number>`count(*) filter (where ${tradesTable.status} = 'open')::int`,
      closedTrades: sql<number>`count(*) filter (where ${tradesTable.status} <> 'open')::int`,
      protectedOpen: sql<number>`count(*) filter (where ${tradesTable.status} = 'open' and ${tradesTable.stopLoss}::numeric > 0 and ${tradesTable.takeProfit}::numeric > 0)::int`,
      riskViolations: sql<number>`count(*) filter (where ${tradesTable.riskViolation} = true)::int`,
      realizedPnlUsdt: sql<string>`coalesce(sum(case when ${tradesTable.status} <> 'open' then ${tradesTable.pnl}::numeric else 0 end), 0)::text`,
      feesUsdt: sql<string>`coalesce(sum(case when ${tradesTable.status} <> 'open' then ${tradesTable.feesUsdt}::numeric else 0 end), 0)::text`,
      slippageUsdt: sql<string>`coalesce(sum(case when ${tradesTable.status} <> 'open' then ${tradesTable.slippageUsdt}::numeric else 0 end), 0)::text`,
    }).from(tradesTable).where(tradeScope),
    db.select({ regime: regimeExpression, value: count() })
      .from(tradesTable).where(tradeScope).groupBy(regimeExpression),
  ]);
  const claimCount = (status: string) => Number(claimCounts.find((row) => row.status === status)?.value ?? 0);
  const totals = tradeTotals[0] ?? {
    trades: 0, openTrades: 0, closedTrades: 0, protectedOpen: 0, riskViolations: 0,
    realizedPnlUsdt: "0", feesUsdt: "0", slippageUsdt: "0",
  };
  const autonomousDecisions = claimCounts.reduce((sum, row) => sum + Number(row.value), 0);
  const executed = claimCount("EXECUTED");
  const refused = claimCount("REFUSED");
  const failed = claimCount("FAILED");
  const regimeMix = Object.fromEntries(regimeRows.map((row) => [row.regime, Number(row.value)]));
  const elapsedDays = Math.max(1 / 24, (Date.now() - Date.parse(snapshot.mandate.createdAt)) / 86_400_000);
  const metrics = {
    autonomousDecisions,
    executed,
    refused,
    failed,
    decisionFrequencyPerDay: autonomousDecisions / elapsedDays,
    executionFailureRatePercent: autonomousDecisions > 0 ? (failed / autonomousDecisions) * 100 : 0,
    trades: Number(totals.trades),
    openTrades: Number(totals.openTrades),
    closedTrades: Number(totals.closedTrades),
    protectionCoveragePercent: Number(totals.openTrades) > 0 ? (Number(totals.protectedOpen) / Number(totals.openTrades)) * 100 : 100,
    riskViolations: Number(totals.riskViolations),
    realizedPnlUsdt: Number(totals.realizedPnlUsdt),
    feesUsdt: Number(totals.feesUsdt),
    slippageUsdt: Number(totals.slippageUsdt),
    regimeMix,
  };
  const core = {
    schemaVersion: "phase10-forward-soak-v1",
    mandateId: snapshot.mandate.id,
    mandateVersion: snapshot.mandate.version,
    mandateFingerprint: snapshot.mandate.fingerprint,
    brainVersion: snapshot.mandate.brainVersion,
    authority: snapshot.mandate.executionAuthority,
    mandateState: snapshot.mandateState.state,
    controlState: snapshot.control.state,
    frozenParameters: snapshot.mandate,
    metrics,
    calibration: {
      status: "UNCALIBRATED" as const,
      detail: "Brain V0 confidence remains a strategy score and is not presented as a probability.",
    },
    backtestForwardDrift: {
      status: "UNAVAILABLE" as const,
      detail: "No Research report is silently linked to this mandate; attach reviewed evidence to a future version before computing promotion drift.",
    },
    limitations: [
      "This repository report uses persisted Demo/testnet/practice evidence only; it is not provider-backed verification.",
      "Drawdown uses the existing account balance/equity projection; unavailable provider unrealized equity is not reconstructed.",
      "A green soak report never promotes or enables Live authority.",
    ],
  };
  return {
    status: "AVAILABLE" as const,
    generatedAt: new Date().toISOString(),
    ...core,
    reportFingerprint: sha256Fingerprint(core),
  };
}
