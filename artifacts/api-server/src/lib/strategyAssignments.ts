import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  customStrategiesTable,
  db,
  strategyModeAssignmentsTable,
  type StrategyModeAssignment,
} from "@workspace/db";
import type { Section } from "./engineRegistry";
import type { StrategyConfig } from "./strategies";
import { strategiesForSection } from "./strategies";
import { canonicalJson } from "./plan/fingerprint";
import { ENGINE_VERSION } from "./version";
import { applyStrategyAssignmentPolicy } from "./strategyAssignmentPolicy";

export type StrategyAssignmentMode = "research" | "copilot" | "autopilot";

export interface StrategyAssignmentView {
  strategyId: string;
  brain: boolean;
  copilot: boolean;
  autopilot: boolean;
  revision: number;
  updatedAt: string | null;
}

function assignmentView(
  strategyId: string,
  row: StrategyModeAssignment | undefined,
): StrategyAssignmentView {
  return {
    strategyId,
    brain: row?.brainEnabled ?? true,
    copilot: row?.copilotEnabled ?? true,
    autopilot: row?.autopilotEnabled ?? true,
    revision: row?.revision ?? 0,
    updatedAt: row?.updatedAt.toISOString() ?? null,
  };
}

export async function strategyIdsForUser(
  userId: number,
  section: Section,
): Promise<string[]> {
  const builtIns = strategiesForSection(section).map((strategy) => strategy.strategyId);
  const custom = await db
    .select({ strategyId: customStrategiesTable.strategyId })
    .from(customStrategiesTable)
    .where(
      and(
        eq(customStrategiesTable.userId, userId),
        eq(customStrategiesTable.section, section),
      ),
    );
  return [...builtIns, ...custom.map((row) => row.strategyId).filter(Boolean)];
}

/**
 * Additive compatibility backfill. Existing strategies are assigned to all
 * modes, preserving the pre-redesign behavior exactly.
 */
export async function ensureStrategyAssignments(
  userId: number,
  section: Section,
  strategyIds: readonly string[],
): Promise<void> {
  if (strategyIds.length === 0) return;
  await db
    .insert(strategyModeAssignmentsTable)
    .values(
      strategyIds.map((strategyId) => ({
        userId,
        section,
        strategyId,
        brainEnabled: true,
        copilotEnabled: true,
        autopilotEnabled: true,
        revision: 1,
      })),
    )
    .onConflictDoNothing({
      target: [
        strategyModeAssignmentsTable.userId,
        strategyModeAssignmentsTable.section,
        strategyModeAssignmentsTable.strategyId,
      ],
    });
}

export async function listStrategyAssignments(
  userId: number,
  section: Section,
  strategyIds?: readonly string[],
): Promise<StrategyAssignmentView[]> {
  const ids = strategyIds ? [...strategyIds] : await strategyIdsForUser(userId, section);
  await ensureStrategyAssignments(userId, section, ids);
  const rows = await db
    .select()
    .from(strategyModeAssignmentsTable)
    .where(
      and(
        eq(strategyModeAssignmentsTable.userId, userId),
        eq(strategyModeAssignmentsTable.section, section),
      ),
    );
  const byId = new Map(rows.map((row) => [row.strategyId, row]));
  return ids.map((strategyId) => assignmentView(strategyId, byId.get(strategyId)));
}

export class StrategyAssignmentConflictError extends Error {
  readonly code = "STRATEGY_ASSIGNMENT_REVISION_CONFLICT";
}

export class StrategyAssignmentNotFoundError extends Error {
  readonly code = "STRATEGY_ASSIGNMENT_NOT_FOUND";
}

export async function updateStrategyAssignment(input: {
  userId: number;
  section: Section;
  strategyId: string;
  expectedRevision: number;
  brain: boolean;
  copilot: boolean;
  autopilot: boolean;
}): Promise<StrategyAssignmentView> {
  const ids = await strategyIdsForUser(input.userId, input.section);
  if (!ids.includes(input.strategyId)) {
    throw new StrategyAssignmentNotFoundError(
      "Strategy is not present in this market's catalog",
    );
  }

  try {
    return await db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(strategyModeAssignmentsTable)
        .where(
          and(
            eq(strategyModeAssignmentsTable.userId, input.userId),
            eq(strategyModeAssignmentsTable.section, input.section),
            eq(strategyModeAssignmentsTable.strategyId, input.strategyId),
          ),
        )
        .for("update")
        .limit(1);

      if (!current) {
        if (input.expectedRevision !== 0) {
          throw new StrategyAssignmentConflictError(
            "Strategy assignment changed; refresh before trying again",
          );
        }
        const [created] = await tx
          .insert(strategyModeAssignmentsTable)
          .values({
            userId: input.userId,
            section: input.section,
            strategyId: input.strategyId,
            brainEnabled: input.brain,
            copilotEnabled: input.copilot,
            autopilotEnabled: input.autopilot,
            revision: 1,
          })
          .returning();
        if (!created) throw new Error("Strategy assignment insert returned no row");
        return assignmentView(input.strategyId, created);
      }

      if (current.revision !== input.expectedRevision) {
        throw new StrategyAssignmentConflictError(
          "Strategy assignment changed; refresh before trying again",
        );
      }

      const [updated] = await tx
        .update(strategyModeAssignmentsTable)
        .set({
          brainEnabled: input.brain,
          copilotEnabled: input.copilot,
          autopilotEnabled: input.autopilot,
          revision: current.revision + 1,
        })
        .where(
          and(
            eq(strategyModeAssignmentsTable.id, current.id),
            eq(strategyModeAssignmentsTable.revision, current.revision),
          ),
        )
        .returning();
      if (!updated) {
        throw new StrategyAssignmentConflictError(
          "Strategy assignment changed; refresh before trying again",
        );
      }
      return assignmentView(input.strategyId, updated);
    });
  } catch (error) {
    const postgresCode =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : null;
    if (postgresCode === "23505") {
      throw new StrategyAssignmentConflictError(
        "Strategy assignment changed; refresh before trying again",
      );
    }
    throw error;
  }
}

/**
 * Brain and Co-Pilot use the desired assignment set on the next scan.
 * AutoPilot intentionally does not: its active immutable mandate remains the
 * authority until a separately approved replacement exists.
 */
export async function configsForAssignedMode(
  userId: number,
  section: Section,
  mode: StrategyAssignmentMode,
  configs: Map<string, StrategyConfig>,
): Promise<Map<string, StrategyConfig>> {
  if (mode === "autopilot") return configs;
  const assignments = await listStrategyAssignments(
    userId,
    section,
    [...configs.keys()],
  );
  return applyStrategyAssignmentPolicy(mode, configs, assignments);
}

export function builtInStrategyIdentity(strategyId: string): {
  version: string;
  fingerprint: string;
} {
  const payload = canonicalJson({
    kind: "built-in",
    engineVersion: ENGINE_VERSION,
    strategyId,
  });
  return {
    version: `engine-${ENGINE_VERSION}`,
    fingerprint: createHash("sha256").update(payload).digest("hex"),
  };
}

export function customStrategyIdentity(row: {
  strategyId: string;
  rules: unknown;
  rulesUpdatedAt: Date;
}): { version: string; fingerprint: string } {
  const fingerprint = createHash("sha256")
    .update(
      canonicalJson({
        kind: "custom",
        strategyId: row.strategyId,
        rules: row.rules,
        rulesUpdatedAt: row.rulesUpdatedAt.toISOString(),
      }),
    )
    .digest("hex");
  return {
    version: `custom-${fingerprint.slice(0, 12)}`,
    fingerprint,
  };
}
