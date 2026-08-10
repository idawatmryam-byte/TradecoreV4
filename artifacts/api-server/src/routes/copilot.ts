/**
 * TradeCore Pro — Co-Pilot routes
 *
 * The human's side of the fork point. Three actions on a recommendation, all
 * of them non-GET — which means the demo read-only guard already blocks them
 * for the showroom account with no extra work here (see middleware/demoGuard).
 */
import { Router, type IRouter } from "express";
import type { Recommendation } from "@workspace/db";
import {
  GetCopilotInboxResponse,
  ExecuteRecommendationResponse,
  RejectRecommendationResponse,
  ModifyRecommendationResponse,
  GetRecommendationWorkspaceResponse,
} from "@workspace/api-zod";
import {
  executeRecommendation,
  auditApprovalRefusal,
  getRecommendationWorkspace,
  listInbox,
  modifyRecommendation,
  rejectRecommendation,
  type ActionOutcome,
} from "../lib/copilot/copilotService";
import { RECOMMENDATION_STATUSES } from "@workspace/db";
import {
  verifyFinancialRequestOrigin,
  verifyFinancialStepUp,
} from "../middleware/auth";
import { rateLimit } from "../middleware/rateLimit";

const router: IRouter = Router();
const approvalRateLimit = rateLimit({
  name: "copilot-approval",
  windowMs: 15 * 60_000,
  max: 20,
  keyFn: (req) => `${req.userId ?? "unknown"}:${req.ip ?? "unknown"}`,
});

function mapRecommendation(r: Recommendation) {
  const plan = r.plan as { report?: { summary?: string } } | null;
  return {
    id: r.id,
    status: r.status,
    authoredBy: r.authoredBy,
    derivedFromId: r.derivedFromId ?? null,
    symbol: r.symbol,
    strategyId: r.strategyId,
    strategyName: r.strategyName ?? null,
    side: r.side,
    confidence: Number(r.confidence),
    entryPrice: Number(r.entryPrice),
    slPrice: Number(r.slPrice),
    tpPrice: Number(r.tpPrice),
    qty: Number(r.qty),
    leverage: r.leverage,
    planFingerprint: r.planFingerprint,
    entryReason: plan?.report?.summary ?? null,
    expiresAt: r.expiresAt.toISOString(),
    createdAt: r.createdAt.toISOString(),
    actedAt: r.actedAt ? r.actedAt.toISOString() : null,
    tradeId: r.tradeId ?? null,
    resolutionReason: r.resolutionReason ?? null,
    executionTarget:
      r.executionTarget === "demo" || r.executionTarget === "live"
        ? r.executionTarget
        : null,
    decisionBundleFingerprint: r.decisionBundleFingerprint ?? null,
    approvalState:
      r.status === "executed" || r.status === "executing"
        ? "APPROVED"
        : r.status === "rejected"
          ? "REJECTED"
          : r.status === "expired" ||
              (r.status === "created" && new Date() >= r.expiresAt)
            ? "EXPIRED"
            : r.status === "stale"
              ? "STALE"
              : r.status === "invalidated" || r.status === "superseded"
                ? "INVALIDATED"
                : r.status === "blocked"
                  ? "EXECUTION_BLOCKED"
                  : "PROPOSED",
  };
}

function mapOutcome(o: ActionOutcome) {
  return {
    ok: o.ok,
    status: o.status,
    reason: o.reason,
    ...(o.checks && { checks: o.checks }),
    ...(o.tradeId != null && { tradeId: o.tradeId }),
    ...(o.newRecommendationId != null && { newRecommendationId: o.newRecommendationId,
    }),
    ...(o.code && { code: o.code }),
    ...(o.idempotentReplay && { idempotentReplay: true }),
  };
}

router.get("/copilot/inbox", async (req, res): Promise<void> => {
  const raw = typeof req.query["status"] === "string" ? req.query["status"] : "";
  const requested = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const status = requested.filter((s): s is Recommendation["status"] =>
    (RECOMMENDATION_STATUSES as readonly string[]).includes(s),
  );
  const limit = Number(req.query["limit"] ?? 50);

  const rows = await listInbox(req.userId!, req.section!, {
    ...(status.length > 0 && { status }),
    ...(Number.isFinite(limit) && { limit }),
  });
  res.json(GetCopilotInboxResponse.parse({ recommendations: rows.map(mapRecommendation),
    }),
  );
});

router.get("/copilot/recommendations/:id", async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid recommendation id" }); return; }
  const workspace = await getRecommendationWorkspace(req.userId!, req.section!, id,
  );
  if (!workspace) { res.status(404).json({ error: "Recommendation not found" }); return; }
  res.json(GetRecommendationWorkspaceResponse.parse({
    recommendation: mapRecommendation(workspace.recommendation),
    decisionTrace: workspace.decisionTrace ?? [],
    portfolioImpact: workspace.portfolioImpact,
    similarTrades: workspace.similarTrades,
      decisionBundle: workspace.decisionBundle,
      decisionBundleFingerprint: workspace.decisionBundleFingerprint,
      executionTarget: workspace.executionTarget,
      approvalChallenge: workspace.approvalChallenge,
      approvalState: workspace.approvalState,
      approvalReadiness: workspace.approvalReadiness,
      auditEvents: workspace.auditEvents.map((event) => ({
        id: event.id,
        eventType: event.eventType,
        actorType: event.actorType,
        actorUserId: event.actorUserId ?? null,
        fromStatus: event.fromStatus ?? null,
        toStatus: event.toStatus,
        reasonCode: event.reasonCode,
        reason: event.reason,
        occurredAt: event.occurredAt.toISOString(),
      })),
    }),
  );
});

router.post("/copilot/recommendations/:id/execute",
  approvalRateLimit,
  async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid recommendation id" }); return; }
  const origin = verifyFinancialRequestOrigin(req);
    if (!origin.ok) {
      await auditApprovalRefusal(
        req.userId!,
        req.section!,
        id,
        "ORIGIN_REJECTED",
        origin.reason,
      );
      res.status(403).json({ error: origin.reason, code: "ORIGIN_REJECTED" });
      return;
    }
    const body = req.body ?? {};
    const hash = (value: unknown) =>
      typeof value === "string" && /^[a-f0-9]{64}$/i.test(value) ? value : null;
    const expectedPlanFingerprint = hash(body.expectedPlanFingerprint);
    const expectedDecisionBundleFingerprint = hash(
      body.expectedDecisionBundleFingerprint,
    );
    const executionTarget =
      body.executionTarget === "demo" || body.executionTarget === "live"
        ? body.executionTarget
        : null;
    const approvalChallenge =
      typeof body.approvalChallenge === "string" &&
      /^[0-9a-f-]{36}$/i.test(body.approvalChallenge)
        ? body.approvalChallenge
        : null;
    const idempotencyKey =
      typeof body.idempotencyKey === "string" &&
      body.idempotencyKey.length >= 16 &&
      body.idempotencyKey.length <= 200
        ? body.idempotencyKey
        : null;
    const confirmation =
      typeof body.confirmation === "string" && body.confirmation.length <= 200
        ? body.confirmation
        : null;
    if (
      !expectedPlanFingerprint ||
      !expectedDecisionBundleFingerprint ||
      !executionTarget ||
      !approvalChallenge ||
      !idempotencyKey ||
      !confirmation
    ) {
      res
        .status(400)
        .json({
          error:
            "Approval requires exact plan/decision fingerprints, target, challenge, idempotency key, and confirmation",
        });
      return;
    }
    if (executionTarget === "live") {
      const stepUp = await verifyFinancialStepUp(
        req,
        req.userId!,
        body.password,
      );
      if (!stepUp.ok) {
        await auditApprovalRefusal(
          req.userId!,
          req.section!,
          id,
          "STEP_UP_REQUIRED",
          stepUp.reason,
        );
        res
          .status(403)
          .json({ error: stepUp.reason, code: "STEP_UP_REQUIRED" });
        return;
      }
    }
    const outcome = await executeRecommendation(req.userId!, req.section!, id, {
      expectedPlanFingerprint,
      expectedDecisionBundleFingerprint,
      executionTarget,
      approvalChallenge,
      idempotencyKey,
      confirmation,
    });
  req.log.info({ recommendationId: id, ok: outcome.ok, status: outcome.status }, "Co-Pilot execute",
    );
  // A refused approval is a normal, expected answer — the body carries every
  // check that ran so the UI can explain WHY rather than just failing.
  res.json(ExecuteRecommendationResponse.parse(mapOutcome(outcome)));
},
);

router.post("/copilot/recommendations/:id/reject", async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid recommendation id" }); return; }
  const origin = verifyFinancialRequestOrigin(req);
    if (!origin.ok) {
      await auditApprovalRefusal(
        req.userId!,
        req.section!,
        id,
        "ORIGIN_REJECTED",
        origin.reason,
      );
      res.status(403).json({ error: origin.reason, code: "ORIGIN_REJECTED" });
      return;
    }
    const note = typeof req.body?.note === "string" ? req.body.note.trim() : undefined;
  const expectedPlanFingerprint =
      typeof req.body?.expectedPlanFingerprint === "string" &&
      /^[a-f0-9]{64}$/i.test(req.body.expectedPlanFingerprint)
        ? req.body.expectedPlanFingerprint
        : null;
    const approvalChallenge =
      typeof req.body?.approvalChallenge === "string" &&
      /^[0-9a-f-]{36}$/i.test(req.body.approvalChallenge)
        ? req.body.approvalChallenge
        : null;
    if (
      !expectedPlanFingerprint ||
      !approvalChallenge ||
      (note?.length ?? 0) > 1000
    ) {
      res
        .status(400)
        .json({
          error:
            "Rejection requires the exact plan fingerprint, current challenge, and an optional note up to 1000 characters",
        });
      return;
    }
    const outcome = await rejectRecommendation(req.userId!, req.section!, id, {
      expectedPlanFingerprint,
      approvalChallenge,
      ...(note && { note }),
    });
  res.json(RejectRecommendationResponse.parse(mapOutcome(outcome)));
},
);

router.post("/copilot/recommendations/:id/modify", async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid recommendation id" }); return; }
  const origin = verifyFinancialRequestOrigin(req);
    if (!origin.ok) {
      await auditApprovalRefusal(
        req.userId!,
        req.section!,
        id,
        "ORIGIN_REJECTED",
        origin.reason,
      );
      res.status(403).json({ error: origin.reason, code: "ORIGIN_REJECTED" });
      return;
    }
    const num = (v: unknown) =>
      typeof v === "number" && Number.isFinite(v) ? v : undefined;
  const changes = {
    ...(num(req.body?.slPrice) !== undefined && { slPrice: num(req.body.slPrice)!,
      }),
    ...(num(req.body?.tpPrice) !== undefined && { tpPrice: num(req.body.tpPrice)!,
      }),
    ...(num(req.body?.qty) !== undefined && { qty: num(req.body.qty)! }),
  };
  if (Object.keys(changes).length === 0) {
    res.status(400).json({ error: "Provide at least one of slPrice, tpPrice or qty" });
    return;
  }
  const outcome = await modifyRecommendation(req.userId!, req.section!, id, changes,
    );
  res.json(ModifyRecommendationResponse.parse(mapOutcome(outcome)));
},
);

export default router;
