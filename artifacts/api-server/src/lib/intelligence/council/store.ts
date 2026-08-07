import {
  brainDecisionsTable,
  brainEvidenceReferencesTable,
  db,
  shadowCouncilRunsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import type { ShadowCouncilRun } from "./types";

/** Append a complete Shadow run without ever updating an earlier record. */
export async function recordShadowCouncilRun(
  userId: number,
  section: "crypto" | "forex",
  run: ShadowCouncilRun,
): Promise<void> {
  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(brainDecisionsTable)
      .values({
        userId,
        section,
        decisionId: run.decision.decisionId,
        schemaVersion: run.decision.schemaVersion,
        brainVersion: run.decision.versions.brain,
        action: run.decision.action,
        symbol: run.decision.symbol,
        marketStateFingerprint: run.decision.marketStateFingerprint,
        decisionFingerprint: run.decisionFingerprint,
        dataTimestamp: new Date(run.decision.dataTimestamp),
        expiresAt: new Date(run.decision.expiresAt),
        decision: run.decision,
      })
      .onConflictDoNothing({
        target: [brainDecisionsTable.userId, brainDecisionsTable.section, brainDecisionsTable.decisionId],
      })
      .returning({ id: brainDecisionsTable.id });

    let brainDecisionId = inserted[0]?.id;
    if (brainDecisionId == null) {
      const existing = await tx
        .select({ id: brainDecisionsTable.id })
        .from(brainDecisionsTable)
        .where(and(
          eq(brainDecisionsTable.userId, userId),
          eq(brainDecisionsTable.section, section),
          eq(brainDecisionsTable.decisionId, run.decision.decisionId),
        ))
        .limit(1);
      brainDecisionId = existing[0]?.id;
    }
    if (brainDecisionId == null) throw new Error("Unable to resolve append-only brain decision");

    const evidence = [...run.decision.supportingEvidence, ...run.decision.opposingEvidence];
    if (evidence.length > 0) {
      await tx
        .insert(brainEvidenceReferencesTable)
        .values(evidence.map((item) => ({
          brainDecisionId,
          evidenceId: item.evidenceId,
          kind: item.kind,
          source: item.source,
          reference: item.reference,
          evidenceFingerprint: item.fingerprint ?? null,
          dataTimestamp: new Date(item.dataTimestamp),
          metadata: { summary: item.summary, strength: item.strength },
        })))
        .onConflictDoNothing({
          target: [brainEvidenceReferencesTable.brainDecisionId, brainEvidenceReferencesTable.evidenceId],
        });
    }

    await tx
      .insert(shadowCouncilRunsTable)
      .values({
        userId,
        section,
        runId: run.runId,
        brainDecisionId,
        councilVersion: run.councilVersion,
        inputFingerprint: run.inputFingerprint,
        runFingerprint: run.runFingerprint,
        reasoningStatus: run.reasoning.status,
        providerId: run.reasoning.providerId,
        modelVersion: run.reasoning.modelVersion,
        inputTokens: run.reasoning.usage.inputTokens,
        outputTokens: run.reasoning.usage.outputTokens,
        costUsd: run.reasoning.usage.costUsd == null ? null : String(run.reasoning.usage.costUsd),
        deterministicAssessment: run.deterministicAssessment,
        brainV0Comparison: run.replay.brainV0,
        reasoning: run.reasoning,
        replayBundle: run.replay,
        generatedAt: new Date(run.generatedAt),
      })
      .onConflictDoNothing({
        target: [shadowCouncilRunsTable.userId, shadowCouncilRunsTable.section, shadowCouncilRunsTable.runId],
      });
  });
}

