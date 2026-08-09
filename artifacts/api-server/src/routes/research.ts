import { Router } from "express";
import { ZodError } from "zod";
import {
  ResearchExperimentRequestSchema,
  prepareResearchExperiment,
  runResearchExperimentJob,
} from "../lib/intelligence/research/runner";
import {
  ResearchConcurrencyError,
  ResearchExperimentStore,
} from "../lib/intelligence/research/store";
import { logger } from "../lib/logger";

const router = Router();
const store = new ResearchExperimentStore();

function sectionOf(value: unknown): "crypto" | "forex" {
  return value === "forex" ? "forex" : "crypto";
}

function parseId(value: string): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function serializeExperiment(record: Awaited<ReturnType<ResearchExperimentStore["byId"]>> extends infer T ? NonNullable<T> : never) {
  return {
    id: record.id,
    section: record.section,
    experimentId: record.experimentId,
    name: record.name,
    status: record.status,
    stage: record.stage,
    progress: record.progress,
    cancelRequested: record.cancelRequested,
    decisionEventCount: record.decisionEventCount,
    managementEventCount: record.managementEventCount,
    manifestFingerprint: record.manifestFingerprint,
    goldenStreamFingerprint: record.goldenStreamFingerprint,
    mode: "research" as const,
    cannotExecute: true as const,
    request: record.request,
    manifest: record.manifest,
    report: record.report,
    error: record.error,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
  };
}

router.get("/research/experiments", async (req, res) => {
  const records = await store.list(req.userId!, sectionOf(req.section));
  return res.json(records.map(serializeExperiment));
});

router.post("/research/experiments", async (req, res) => {
  try {
    const request = ResearchExperimentRequestSchema.parse(req.body);
    const section = sectionOf(req.section);
    const userId = req.userId!;
    const storedRequest = {
      ...request,
      startDate: request.startDate.toISOString(),
      endDate: request.endDate.toISOString(),
    };
    const record = await store.createRequest(
      userId,
      section,
      request.name,
      storedRequest,
    );

    void (async () => {
      try {
        const prepared = await prepareResearchExperiment(userId, section, request);
        if (await store.cancellationRequested(userId, section, record.id)) {
          await store.markCancelled(userId, section, record.id);
          return;
        }
        await store.attachManifest(userId, section, record.id, prepared.manifest);
        await runResearchExperimentJob(userId, section, record.id, prepared, store);
      } catch (error) {
        logger.error({ err: error, userId, section, experimentDbId: record.id }, "Research preparation failed");
        try {
          await store.fail(userId, section, record.id, error);
        } catch (persistenceError) {
          logger.error({ err: persistenceError, userId, section, experimentDbId: record.id }, "Research preparation failure state could not be persisted");
        }
      }
    })();

    return res.status(202).json({
      id: record.id,
      status: "preparing",
      mode: "research",
      cannotExecute: true,
    });
  } catch (error) {
    if (error instanceof ResearchConcurrencyError) {
      return res.status(409).json({ error: error.message });
    }
    if (error instanceof ZodError) {
      return res.status(400).json({
        error: error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; "),
      });
    }
    logger.error({ err: error, userId: req.userId }, "Research request creation failed");
    return res.status(500).json({ error: "Research request could not be created" });
  }
});

router.get("/research/experiments/:id", async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: "Invalid experiment id" });
  const record = await store.byId(req.userId!, sectionOf(req.section), id);
  if (!record) return res.status(404).json({ error: "Research experiment not found" });
  return res.json(serializeExperiment(record));
});

router.get("/research/experiments/:id/events", async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: "Invalid experiment id" });
  const afterSequence = Number(req.query.afterSequence ?? -1);
  const limit = Number(req.query.limit ?? 100);
  if (!Number.isInteger(afterSequence) || afterSequence < -1 || !Number.isInteger(limit) || limit < 1 || limit > 500) {
    return res.status(400).json({ error: "afterSequence must be at least -1 and limit must be from 1 to 500" });
  }
  const section = sectionOf(req.section);
  const record = await store.byId(req.userId!, section, id);
  if (!record) return res.status(404).json({ error: "Research experiment not found" });
  const events = await store.events(req.userId!, section, id, afterSequence, limit);
  const serialized = events.map((event) => ({
    sequence: event.sequence,
    kind: event.kind,
    partitionId: event.partitionId,
    observedAt: event.observedAt,
    symbol: event.symbol,
    tradeId: event.tradeId,
    eventFingerprint: event.eventFingerprint,
    event: event.event,
  }));
  const nextAfterSequence = serialized.at(-1)?.sequence ?? afterSequence;
  return res.json({
    events: serialized,
    nextAfterSequence,
    hasMore: nextAfterSequence < record.decisionEventCount + record.managementEventCount - 1,
  });
});

router.post("/research/experiments/:id/cancel", async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: "Invalid experiment id" });
  const requested = await store.requestCancellation(req.userId!, sectionOf(req.section), id);
  if (!requested) return res.status(409).json({ error: "Research experiment is not cancellable" });
  return res.status(202).json({ cancelRequested: true });
});

export default router;
