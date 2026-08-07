import { db, strategyOpinionsTable } from "@workspace/db";
import type { SpecialistCouncilSnapshot } from "./types";

const INSERT_BATCH_SIZE = 500;

export async function recordSpecialistOpinions(
  userId: number,
  section: "crypto" | "forex",
  snapshots: readonly SpecialistCouncilSnapshot[],
): Promise<void> {
  const rows = snapshots.flatMap((snapshot) =>
    snapshot.opinions.map((view) => ({
      userId,
      section,
      opinionId: view.opinion.opinionId,
      specialistId: view.opinion.specialistId,
      specialistVersion: view.opinion.specialistVersion,
      role: view.role,
      correlationGroup: view.correlationGroup,
      correlationDiscount: String(view.correlationDiscount),
      effectiveStrength: String(view.effectiveStrength),
      symbol: view.opinion.symbol,
      marketStateFingerprint: view.opinion.marketStateFingerprint,
      stance: view.opinion.stance,
      dataTimestamp: new Date(view.opinion.dataTimestamp),
      expiresAt: new Date(view.opinion.expiresAt),
      opinion: view.opinion,
    })),
  );

  for (let offset = 0; offset < rows.length; offset += INSERT_BATCH_SIZE) {
    await db
      .insert(strategyOpinionsTable)
      .values(rows.slice(offset, offset + INSERT_BATCH_SIZE))
      .onConflictDoNothing({
        target: [strategyOpinionsTable.userId, strategyOpinionsTable.section, strategyOpinionsTable.opinionId],
      });
  }
}

