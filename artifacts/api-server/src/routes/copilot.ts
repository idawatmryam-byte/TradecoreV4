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
} from "@workspace/api-zod";
import {
  executeRecommendation,
  listInbox,
  modifyRecommendation,
  rejectRecommendation,
  type ActionOutcome,
} from "../lib/copilot/copilotService";
import { RECOMMENDATION_STATUSES } from "@workspace/db";

const router: IRouter = Router();

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
  };
}

function mapOutcome(o: ActionOutcome) {
  return {
    ok: o.ok,
    status: o.status,
    reason: o.reason,
    ...(o.checks && { checks: o.checks }),
    ...(o.tradeId != null && { tradeId: o.tradeId }),
    ...(o.newRecommendationId != null && { newRecommendationId: o.newRecommendationId }),
  };
}

router.get("/copilot/inbox", async (req, res): Promise<void> => {
  const raw = typeof req.query["status"] === "string" ? req.query["status"] : "";
  const requested = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const status = requested.filter((s): s is Recommendation["status"] =>
    (RECOMMENDATION_STATUSES as readonly string[]).includes(s));
  const limit = Number(req.query["limit"] ?? 50);

  const rows = await listInbox(req.userId!, req.section!, {
    ...(status.length > 0 && { status }),
    ...(Number.isFinite(limit) && { limit }),
  });
  res.json(GetCopilotInboxResponse.parse({ recommendations: rows.map(mapRecommendation) }));
});

router.post("/copilot/recommendations/:id/execute", async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid recommendation id" }); return; }
  const outcome = await executeRecommendation(req.userId!, req.section!, id);
  req.log.info({ recommendationId: id, ok: outcome.ok, status: outcome.status }, "Co-Pilot execute");
  // A refused approval is a normal, expected answer — the body carries every
  // check that ran so the UI can explain WHY rather than just failing.
  res.json(ExecuteRecommendationResponse.parse(mapOutcome(outcome)));
});

router.post("/copilot/recommendations/:id/reject", async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid recommendation id" }); return; }
  const note = typeof req.body?.note === "string" ? req.body.note : undefined;
  const outcome = await rejectRecommendation(req.userId!, req.section!, id, note);
  res.json(RejectRecommendationResponse.parse(mapOutcome(outcome)));
});

router.post("/copilot/recommendations/:id/modify", async (req, res): Promise<void> => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid recommendation id" }); return; }
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const changes = {
    ...(num(req.body?.slPrice) !== undefined && { slPrice: num(req.body.slPrice)! }),
    ...(num(req.body?.tpPrice) !== undefined && { tpPrice: num(req.body.tpPrice)! }),
    ...(num(req.body?.qty) !== undefined && { qty: num(req.body.qty)! }),
  };
  if (Object.keys(changes).length === 0) {
    res.status(400).json({ error: "Provide at least one of slPrice, tpPrice or qty" });
    return;
  }
  const outcome = await modifyRecommendation(req.userId!, req.section!, id, changes);
  res.json(ModifyRecommendationResponse.parse(mapOutcome(outcome)));
});

export default router;
