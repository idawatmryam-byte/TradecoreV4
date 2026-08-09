import { randomUUID } from "node:crypto";
import {
  db,
  positionManagementEventsTable,
  positionThesesTable,
} from "@workspace/db";
import { and, asc, eq } from "drizzle-orm";
import type { Section } from "../../engineRegistry";
import {
  parsePositionActionValidation,
  parsePositionManagementAction,
  parsePositionThesis,
  parsePositionThesisEvaluation,
  type PositionActionValidation,
  type PositionManagementAction,
  type PositionThesis,
  type PositionThesisEvaluation,
} from "./types";

export type ManagementEventStage =
  | "PROPOSED"
  | "SHADOW"
  | "APPLIED"
  | "FAILED"
  | "REFUSED";

export function positionThesisInsertValues(
  userId: number,
  section: Section,
  tradeId: number,
  thesis: PositionThesis,
) {
  return {
    userId,
    section,
    tradeId,
    thesisId: thesis.thesisId,
    schemaVersion: thesis.schemaVersion,
    policyVersion: thesis.managementPolicyVersion,
    thesisFingerprint: thesis.fingerprint,
    thesis,
  };
}

export async function loadPositionThesis(
  userId: number,
  section: Section,
  tradeId: number,
): Promise<PositionThesis | null> {
  const [row] = await db
    .select({ thesis: positionThesesTable.thesis })
    .from(positionThesesTable)
    .where(
      and(
        eq(positionThesesTable.userId, userId),
        eq(positionThesesTable.section, section),
        eq(positionThesesTable.tradeId, tradeId),
      ),
    )
    .limit(1);
  return row ? parsePositionThesis(row.thesis) : null;
}

export interface RecordManagementEventInput {
  userId: number;
  section: Section;
  tradeId: number;
  thesisId: string;
  stage: ManagementEventStage;
  evaluation: PositionThesisEvaluation;
  action: PositionManagementAction;
  validation: PositionActionValidation;
  result?: Record<string, unknown> | null;
  observedAt: Date;
}

/** Returns false when this exact action/stage already exists. */
export async function recordManagementEvent(
  input: RecordManagementEventInput,
): Promise<boolean> {
  const rows = await db
    .insert(positionManagementEventsTable)
    .values({
      eventId: randomUUID(),
      userId: input.userId,
      section: input.section,
      tradeId: input.tradeId,
      thesisId: input.thesisId,
      actionFingerprint: input.action.fingerprint,
      stage: input.stage,
      thesisState: input.evaluation.state,
      actionType: input.action.type,
      policyVersion: input.action.policyVersion,
      marketStateFingerprint: input.action.marketStateFingerprint,
      validationPassed: input.validation.valid,
      evaluation: input.evaluation,
      action: input.action,
      validation: input.validation,
      result: input.result ?? null,
      observedAt: input.observedAt,
    })
    .onConflictDoNothing()
    .returning({ id: positionManagementEventsTable.id });
  return rows.length === 1;
}

export async function getPositionThesisView(
  userId: number,
  section: Section,
  tradeId: number,
) {
  const thesis = await loadPositionThesis(userId, section, tradeId);
  if (!thesis) return null;
  const rows = await db
    .select()
    .from(positionManagementEventsTable)
    .where(
      and(
        eq(positionManagementEventsTable.userId, userId),
        eq(positionManagementEventsTable.section, section),
        eq(positionManagementEventsTable.tradeId, tradeId),
      ),
    )
    .orderBy(
      asc(positionManagementEventsTable.createdAt),
      asc(positionManagementEventsTable.id),
    );
  return {
    thesis,
    events: rows.map((row) => ({
      eventId: row.eventId,
      stage: row.stage,
      thesisState: row.thesisState,
      actionType: row.actionType,
      policyVersion: row.policyVersion,
      marketStateFingerprint: row.marketStateFingerprint,
      validationPassed: row.validationPassed,
      evaluation: parsePositionThesisEvaluation(row.evaluation),
      action: parsePositionManagementAction(row.action),
      validation: parsePositionActionValidation(row.validation),
      result: row.result,
      observedAt: row.observedAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    })),
  };
}
