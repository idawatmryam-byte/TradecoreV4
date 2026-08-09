import {
  db,
  researchExperimentsTable,
  researchReplayEventsTable,
  type ResearchExperimentRecord,
} from "@workspace/db";
import { and, asc, desc, eq, gt, gte, lt, sql } from "drizzle-orm";
import type {
  FullBrainFrameReplay,
  ResearchExperimentManifest,
  ResearchPromotionReport,
} from ".";

export const MAX_RESEARCH_REPLAY_EVENTS = 100_000;
export const MAX_RESEARCH_EVENT_PAGE_SIZE = 500;

export class ResearchConcurrencyError extends Error {
  constructor() {
    super("Only one Research experiment may prepare or run per tenant and section");
    this.name = "ResearchConcurrencyError";
  }
}

function assertTenantRecord(
  record: ResearchExperimentRecord | undefined,
): asserts record is ResearchExperimentRecord {
  if (!record) throw new Error("Research experiment not found");
}

export class ResearchExperimentStore {
  async createRequest(
    userId: number,
    section: "crypto" | "forex",
    name: string,
    request: object,
  ): Promise<ResearchExperimentRecord> {
    const active = await db
      .select({ id: researchExperimentsTable.id })
      .from(researchExperimentsTable)
      .where(and(
        eq(researchExperimentsTable.userId, userId),
        eq(researchExperimentsTable.section, section),
        sql`${researchExperimentsTable.status} IN ('preparing', 'pending', 'running')`,
      ))
      .limit(1);
    if (active.length > 0) throw new ResearchConcurrencyError();
    let record: ResearchExperimentRecord | undefined;
    try {
      [record] = await db
        .insert(researchExperimentsTable)
        .values({
          userId,
          section,
          name: name.trim().slice(0, 160),
          request,
        })
        .returning();
    } catch (error) {
      const constraint =
        (error as { constraint?: string }).constraint ??
        (error as { cause?: { constraint?: string } }).cause?.constraint;
      if (constraint === "research_experiments_one_active_per_tenant_idx")
        throw new ResearchConcurrencyError();
      throw error;
    }
    if (!record)
      throw new Error("Research experiment request could not be created");
    return record;
  }

  async attachManifest(
    userId: number,
    section: "crypto" | "forex",
    id: number,
    manifest: ResearchExperimentManifest,
  ): Promise<ResearchExperimentRecord> {
    const [record] = await db
      .update(researchExperimentsTable)
      .set({
        experimentId: manifest.experimentId,
        name: manifest.name,
        manifestVersion: manifest.schemaVersion,
        manifestFingerprint: manifest.fingerprint,
        manifest: manifest as unknown as object,
        status: "pending",
        stage: "manifest",
        progress: 0,
      })
      .where(
        and(
          eq(researchExperimentsTable.id, id),
          eq(researchExperimentsTable.userId, userId),
          eq(researchExperimentsTable.section, section),
          eq(researchExperimentsTable.status, "preparing"),
        ),
      )
      .returning();
    if (!record)
      throw new Error("Research manifest cannot be attached to this request");
    return record;
  }

  async create(
    userId: number,
    section: "crypto" | "forex",
    manifest: ResearchExperimentManifest,
  ): Promise<ResearchExperimentRecord> {
    const [inserted] = await db
      .insert(researchExperimentsTable)
      .values({
        userId,
        section,
        experimentId: manifest.experimentId,
        name: manifest.name,
        manifestVersion: manifest.schemaVersion,
        manifestFingerprint: manifest.fingerprint,
        manifest: manifest as unknown as object,
        request: { source: "prebuilt-manifest" },
        status: "pending",
        stage: "manifest",
      })
      .onConflictDoNothing()
      .returning();
    if (inserted) return inserted;
    const existing = await this.byExperimentId(
      userId,
      section,
      manifest.experimentId,
    );
    assertTenantRecord(existing);
    if (existing.manifestFingerprint !== manifest.fingerprint) {
      throw new Error(
        "Research experiment identifier collides with a different manifest",
      );
    }
    return existing;
  }

  async list(
    userId: number,
    section: "crypto" | "forex",
  ): Promise<ResearchExperimentRecord[]> {
    return db
      .select()
      .from(researchExperimentsTable)
      .where(
        and(
          eq(researchExperimentsTable.userId, userId),
          eq(researchExperimentsTable.section, section),
        ),
      )
      .orderBy(desc(researchExperimentsTable.createdAt));
  }

  async incomplete(): Promise<ResearchExperimentRecord[]> {
    return db
      .select()
      .from(researchExperimentsTable)
      .where(sql`${researchExperimentsTable.status} IN ('preparing', 'pending', 'running')`)
      .orderBy(asc(researchExperimentsTable.createdAt));
  }

  async byId(
    userId: number,
    section: "crypto" | "forex",
    id: number,
  ): Promise<ResearchExperimentRecord | undefined> {
    const [record] = await db
      .select()
      .from(researchExperimentsTable)
      .where(
        and(
          eq(researchExperimentsTable.id, id),
          eq(researchExperimentsTable.userId, userId),
          eq(researchExperimentsTable.section, section),
        ),
      );
    return record;
  }

  async byExperimentId(
    userId: number,
    section: "crypto" | "forex",
    experimentId: string,
  ): Promise<ResearchExperimentRecord | undefined> {
    const [record] = await db
      .select()
      .from(researchExperimentsTable)
      .where(
        and(
          eq(researchExperimentsTable.experimentId, experimentId),
          eq(researchExperimentsTable.userId, userId),
          eq(researchExperimentsTable.section, section),
        ),
      );
    return record;
  }

  async markRunning(
    userId: number,
    section: "crypto" | "forex",
    id: number,
    stage = "replay",
  ): Promise<void> {
    const existing = await this.byId(userId, section, id);
    assertTenantRecord(existing);
    if (existing.cancelRequested)
      throw new Error("Research experiment cancellation requested");
    if (existing.status === "running") {
      await this.updateProgress(userId, section, id, Math.max(1, existing.progress), stage);
      return;
    }
    const [updated] = await db
      .update(researchExperimentsTable)
      .set({
        status: "running",
        stage,
        progress: 1,
        startedAt: new Date(),
        error: null,
      })
      .where(
        and(
          eq(researchExperimentsTable.id, id),
          eq(researchExperimentsTable.userId, userId),
          eq(researchExperimentsTable.section, section),
          eq(researchExperimentsTable.status, "pending"),
        ),
      )
      .returning({ id: researchExperimentsTable.id });
    if (!updated)
      throw new Error("Research experiment cannot transition to running");
  }

  async updateProgress(
    userId: number,
    section: "crypto" | "forex",
    id: number,
    progress: number,
    stage: string,
  ): Promise<void> {
    const bounded = Math.max(1, Math.min(99, Math.floor(progress)));
    await db
      .update(researchExperimentsTable)
      .set({ progress: bounded, stage: stage.slice(0, 120) })
      .where(
        and(
          eq(researchExperimentsTable.id, id),
          eq(researchExperimentsTable.userId, userId),
          eq(researchExperimentsTable.section, section),
          eq(researchExperimentsTable.status, "running"),
        ),
      );
  }

  async appendFrame(
    userId: number,
    section: "crypto" | "forex",
    experimentDbId: number,
    frame: FullBrainFrameReplay,
  ): Promise<void> {
    return this.appendFrames(userId, section, experimentDbId, [frame]);
  }

  async appendFrames(
    userId: number,
    section: "crypto" | "forex",
    experimentDbId: number,
    frames: readonly FullBrainFrameReplay[],
  ): Promise<void> {
    const allEvents = frames
      .flatMap((frame) => [
        ...frame.decisions.map((event) => ({
          kind: "decision" as const,
          event,
        })),
        ...frame.management.map((event) => ({
          kind: "management" as const,
          event,
        })),
      ])
      .sort(
        (a, b) =>
          a.event.sequence - b.event.sequence || a.kind.localeCompare(b.kind),
      );
    if (allEvents.length === 0) return;

    await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT id FROM research_experiments WHERE id = ${experimentDbId} AND user_id = ${userId} AND section = ${section} FOR UPDATE`,
      );
      const [experiment] = await tx
        .select()
        .from(researchExperimentsTable)
        .where(
          and(
            eq(researchExperimentsTable.id, experimentDbId),
            eq(researchExperimentsTable.userId, userId),
            eq(researchExperimentsTable.section, section),
          ),
        );
      assertTenantRecord(experiment);
      if (experiment.status !== "running" || experiment.cancelRequested) {
        throw new Error(
          experiment.cancelRequested
            ? "Research experiment cancellation requested"
            : "Research experiment is not running",
        );
      }
      const currentCount =
        experiment.decisionEventCount + experiment.managementEventCount;
      const overlap = allEvents.filter((item) => item.event.sequence < currentCount);
      if (overlap.length > 0) {
        const persisted = await tx
          .select({
            sequence: researchReplayEventsTable.sequence,
            kind: researchReplayEventsTable.kind,
            fingerprint: researchReplayEventsTable.eventFingerprint,
          })
          .from(researchReplayEventsTable)
          .where(and(
            eq(researchReplayEventsTable.experimentDbId, experimentDbId),
            gte(researchReplayEventsTable.sequence, overlap[0]!.event.sequence),
            lt(researchReplayEventsTable.sequence, currentCount),
          ))
          .orderBy(asc(researchReplayEventsTable.sequence));
        if (
          persisted.length !== overlap.length ||
          persisted.some((item, index) =>
            item.sequence !== overlap[index]!.event.sequence ||
            item.kind !== overlap[index]!.kind ||
            item.fingerprint !== overlap[index]!.event.fingerprint,
          )
        ) {
          throw new Error("Research resume refused because the persisted replay prefix is not reproducible");
        }
      }
      const events = allEvents.filter((item) => item.event.sequence >= currentCount);
      if (events.length === 0) return;
      if (currentCount + events.length > MAX_RESEARCH_REPLAY_EVENTS) {
        throw new Error(
          `Research replay exceeds the ${MAX_RESEARCH_REPLAY_EVENTS} event safety limit`,
        );
      }
      if (events[0]!.event.sequence !== currentCount) {
        throw new Error(
          `Research replay sequence must continue at ${currentCount}`,
        );
      }
      for (let index = 1; index < events.length; index++) {
        if (
          events[index]!.event.sequence !==
          events[index - 1]!.event.sequence + 1
        ) {
          throw new Error(
            "Research replay sequence contains a gap or duplicate",
          );
        }
      }

      for (let index = 0; index < events.length; index += 500) {
        const batch = events
          .slice(index, index + 500)
          .map(({ kind, event }) => ({
            userId,
            section,
            experimentDbId,
            experimentId: event.experimentId,
            sequence: event.sequence,
            kind,
            partitionId: event.partitionId,
            observedAt: new Date(event.observedAt),
            symbol: "symbol" in event ? event.symbol : null,
            tradeId: "tradeId" in event ? event.tradeId : null,
            eventFingerprint: event.fingerprint,
            event: event as unknown as object,
          }));
        await tx.insert(researchReplayEventsTable).values(batch);
      }

      await tx
        .update(researchExperimentsTable)
        .set({
          decisionEventCount:
            experiment.decisionEventCount +
            events.filter((event) => event.kind === "decision").length,
          managementEventCount:
            experiment.managementEventCount +
            events.filter((event) => event.kind === "management").length,
        })
        .where(eq(researchExperimentsTable.id, experimentDbId));
    });
  }

  async events(
    userId: number,
    section: "crypto" | "forex",
    experimentDbId: number,
    afterSequence: number,
    limit: number,
  ) {
    const boundedLimit = Math.max(
      1,
      Math.min(MAX_RESEARCH_EVENT_PAGE_SIZE, Math.floor(limit)),
    );
    const experiment = await this.byId(userId, section, experimentDbId);
    assertTenantRecord(experiment);
    return db
      .select()
      .from(researchReplayEventsTable)
      .where(
        and(
          eq(researchReplayEventsTable.experimentDbId, experimentDbId),
          eq(researchReplayEventsTable.userId, userId),
          eq(researchReplayEventsTable.section, section),
          gt(researchReplayEventsTable.sequence, Math.floor(afterSequence)),
        ),
      )
      .orderBy(asc(researchReplayEventsTable.sequence))
      .limit(boundedLimit);
  }

  async requestCancellation(
    userId: number,
    section: "crypto" | "forex",
    id: number,
  ): Promise<boolean> {
    const [updated] = await db
      .update(researchExperimentsTable)
      .set({ cancelRequested: true })
      .where(
        and(
          eq(researchExperimentsTable.id, id),
          eq(researchExperimentsTable.userId, userId),
          eq(researchExperimentsTable.section, section),
          sql`${researchExperimentsTable.status} IN ('preparing', 'pending', 'running')`,
        ),
      )
      .returning({ id: researchExperimentsTable.id });
    return Boolean(updated);
  }

  async cancellationRequested(
    userId: number,
    section: "crypto" | "forex",
    id: number,
  ): Promise<boolean> {
    const record = await this.byId(userId, section, id);
    assertTenantRecord(record);
    return record.cancelRequested;
  }

  async markCancelled(
    userId: number,
    section: "crypto" | "forex",
    id: number,
  ): Promise<void> {
    await db
      .update(researchExperimentsTable)
      .set({ status: "cancelled", stage: "cancelled", completedAt: new Date() })
      .where(
        and(
          eq(researchExperimentsTable.id, id),
          eq(researchExperimentsTable.userId, userId),
          eq(researchExperimentsTable.section, section),
          sql`${researchExperimentsTable.status} IN ('preparing', 'pending', 'running')`,
        ),
      );
  }

  async complete(
    userId: number,
    section: "crypto" | "forex",
    id: number,
    report: ResearchPromotionReport,
  ): Promise<void> {
    const record = await this.byId(userId, section, id);
    assertTenantRecord(record);
    if (record.status !== "running" || record.cancelRequested)
      throw new Error("Research experiment cannot complete");
    if (
      record.experimentId !== report.experimentId ||
      record.manifestFingerprint !== report.manifestFingerprint
    ) {
      throw new Error(
        "Research report does not belong to the experiment manifest",
      );
    }
    await db
      .update(researchExperimentsTable)
      .set({
        status: "completed",
        stage: "report",
        progress: 100,
        goldenStreamFingerprint: report.goldenStream.actualFingerprint,
        report: report as unknown as object,
        completedAt: new Date(),
      })
      .where(
        and(
          eq(researchExperimentsTable.id, id),
          eq(researchExperimentsTable.userId, userId),
          eq(researchExperimentsTable.section, section),
          eq(researchExperimentsTable.status, "running"),
        ),
      );
  }

  async fail(
    userId: number,
    section: "crypto" | "forex",
    id: number,
    error: unknown,
  ): Promise<void> {
    const message = (
      error instanceof Error ? error.message : String(error)
    ).slice(0, 2_000);
    await db
      .update(researchExperimentsTable)
      .set({
        status: "failed",
        stage: "failed",
        error: message,
        completedAt: new Date(),
      })
      .where(
        and(
          eq(researchExperimentsTable.id, id),
          eq(researchExperimentsTable.userId, userId),
          eq(researchExperimentsTable.section, section),
          sql`${researchExperimentsTable.status} IN ('preparing', 'pending', 'running')`,
        ),
      );
  }
}
