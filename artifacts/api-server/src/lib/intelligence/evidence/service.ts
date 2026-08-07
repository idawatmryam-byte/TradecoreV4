import {
  db,
  botConfigTable,
  evidenceRuleSetsTable,
  evidenceSnapshotsTable,
} from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import type { Section } from "../../engineRegistry";
import {
  currentExecutionTarget,
  loadObservations,
  type ExecutionTarget,
} from "../../knowledge/knowledgeService";
import type { InfluenceState } from "../../memory/influence";
import { buildEvidenceSnapshot } from "./builder";
import type { EvidenceDrift, EvidenceRuleSetView, EvidenceSnapshot } from "./types";

const DRIFT_ORDER: Record<EvidenceDrift["status"], number> = {
  insufficient_data: 0,
  stable: 1,
  watch: 2,
  degraded: 3,
};

export type RuleSetDriftStatus = EvidenceDrift["status"];

/**
 * Map the exact cells in an InfluenceState to the current evidence snapshot.
 * Missing evidence is never silently called stable.
 */
export function driftStatusForInfluenceState(
  state: InfluenceState,
  snapshot: EvidenceSnapshot,
): RuleSetDriftStatus {
  if (state.rules.length === 0) return "insufficient_data";
  let worst: RuleSetDriftStatus = "stable";
  for (const rule of state.rules) {
    const evidence = snapshot.records.find(
      (record) => record.scope.dimension === rule.dimension && record.scope.key === rule.key,
    );
    const status = evidence?.drift.status ?? "insufficient_data";
    if (status === "insufficient_data") return "insufficient_data";
    if (DRIFT_ORDER[status] > DRIFT_ORDER[worst]) worst = status;
  }
  return worst;
}

export async function persistEvidenceSnapshot(
  userId: number,
  section: Section,
  snapshot: EvidenceSnapshot,
): Promise<void> {
  await db.insert(evidenceSnapshotsTable).values({
    userId,
    section,
    snapshotVersion: snapshot.snapshotVersion,
    fingerprint: snapshot.fingerprint,
    executionTarget: snapshot.executionTarget,
    dataCutoff: new Date(snapshot.dataCutoff),
    totalOutcomes: snapshot.totalOutcomes,
    snapshot: snapshot as unknown as object,
  }).onConflictDoNothing();
}

function ruleSetView(row: typeof evidenceRuleSetsTable.$inferSelect): EvidenceRuleSetView {
  return {
    ruleVersion: row.ruleVersion,
    status: row.status as EvidenceRuleSetView["status"],
    validationId: row.validationId,
    executionTarget: row.executionTarget as ExecutionTarget,
    permits: row.permits as "withhold" | "reduce-risk",
    dataCutoff: row.dataCutoff.toISOString(),
    approvedAt: row.approvedAt?.toISOString() ?? null,
    activatedAt: row.activatedAt?.toISOString() ?? null,
    suspendedAt: row.suspendedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    validation: row.validation,
    drift: { status: row.driftStatus },
  };
}

export interface EvidenceOverview {
  readonly executionTarget: ExecutionTarget;
  readonly snapshot: EvidenceSnapshot;
  readonly activeRuleVersion: string | null;
  readonly ruleSets: readonly EvidenceRuleSetView[];
}

/** Current observational evidence plus the independently controlled lifecycle. */
export async function evidenceOverview(userId: number, section: Section): Promise<EvidenceOverview> {
  const executionTarget = await currentExecutionTarget(userId, section);
  const view = await loadObservations(userId, section, { executionTarget });
  const snapshot = buildEvidenceSnapshot(view, { executionTarget });
  await persistEvidenceSnapshot(userId, section, snapshot);

  const [ruleSets, config] = await Promise.all([
    db.select().from(evidenceRuleSetsTable)
      .where(and(eq(evidenceRuleSetsTable.userId, userId), eq(evidenceRuleSetsTable.section, section)))
      .orderBy(desc(evidenceRuleSetsTable.createdAt))
      .limit(20),
    db.select({ active: botConfigTable.memoryInfluenceApprovedVersion })
      .from(botConfigTable)
      .where(and(eq(botConfigTable.userId, userId), eq(botConfigTable.section, section)))
      .limit(1),
  ]);

  return {
    executionTarget,
    snapshot,
    activeRuleVersion: config[0]?.active ?? null,
    ruleSets: ruleSets.map(ruleSetView),
  };
}
