import { Router, type Request, type Response } from "express";
import {
  ApproveTradingMandateBody,
  CreateTradingMandateBody,
  RevokeTradingMandateBody,
  SubmitTradingMandateBody,
  SuspendTradingMandateBody,
} from "@workspace/api-zod";
import {
  getFinancialAuthorizationIdentity,
  verifyFinancialRequestOrigin,
  verifyFinancialStepUp,
} from "../middleware/auth";
import { resolveEligibleTradingAccounts } from "../lib/tradingMandates/service";
import {
  MandateConflictError,
  MandateNotFoundError,
  approveTradingMandate,
  createTradingMandate,
  getTradingMandateUsage,
  getTradingMandateView,
  listTradingMandateDecisions,
  listTradingMandateEvents,
  listTradingMandates,
  transitionTradingMandate,
  type TradingMandateView,
} from "../lib/tradingMandates/store";
import { logger } from "../lib/logger";

const router: Router = Router();

function section(req: Request): "crypto" | "forex" {
  return req.section === "forex" ? "forex" : "crypto";
}

async function requireMutationAuthority(
  req: Request,
  res: Response,
): Promise<{
  role: "OWNER" | "FINANCIAL_OPERATOR";
  sessionVersion: number;
} | null> {
  const origin = verifyFinancialRequestOrigin(req);
  if (!origin.ok) {
    res.status(403).json({ error: origin.reason });
    return null;
  }
  const identity = await getFinancialAuthorizationIdentity(req.userId!);
  if (!identity || !["OWNER", "FINANCIAL_OPERATOR"].includes(identity.role)) {
    res.status(403).json({ error: "Financial-authorization role required" });
    return null;
  }
  return {
    role: identity.role as "OWNER" | "FINANCIAL_OPERATOR",
    sessionVersion: identity.sessionVersion,
  };
}

function handleError(res: Response, error: unknown): void {
  if (error instanceof MandateNotFoundError) {
    res.status(404).json({ error: error.message });
    return;
  }
  if (error instanceof MandateConflictError) {
    res.status(409).json({ error: error.message });
    return;
  }
  const message =
    error instanceof Error ? error.message : "Trading mandate request failed";
  if (
    /unique|duplicate|conflict|stale|not allowed|cannot|requires/i.test(message)
  ) {
    res.status(409).json({ error: message });
    return;
  }
  res.status(400).json({ error: message });
}

function minimumExposure(mandate: TradingMandateView): bigint {
  const terms = mandate.terms;
  const byPositions =
    BigInt(terms.maximumPositionNotional) *
    BigInt(terms.maximumConcurrentPositions);
  return [
    BigInt(terms.maximumAggregateExposure),
    BigInt(terms.canaryAllocation),
    byPositions,
  ].reduce((minimum, value) => (value < minimum ? value : minimum));
}

async function usageView(mandate: TradingMandateView | null) {
  if (!mandate) return null;
  const usage = await getTradingMandateUsage(mandate.id);
  if (!usage) return null;
  const aggregate = usage.aggregateExposure;
  const canaryUsed = usage.canaryUsed;
  const remaining = (limit: string, used: string | null) => {
    if (used === null) return null;
    const value = BigInt(limit) - BigInt(used);
    return (value > 0n ? value : 0n).toString();
  };
  return {
    status: usage.status as "CURRENT" | "STALE" | "UNAVAILABLE",
    calculatedAt: (usage.observedAt ?? usage.updatedAt).toISOString(),
    currency: mandate.terms.settlementCurrency,
    monetaryScale: 8 as const,
    openPositionCount: usage.openPositionCount,
    openOrderCount: usage.openOrderCount,
    aggregateExposure: aggregate,
    remainingExposure: remaining(
      mandate.terms.maximumAggregateExposure,
      aggregate,
    ),
    canaryUsed,
    canaryRemaining: remaining(mandate.terms.canaryAllocation, canaryUsed),
    dailyLoss: usage.dailyLoss,
    weeklyLoss: usage.weeklyLoss,
    monthlyLoss: usage.monthlyLoss,
    drawdownBps: usage.drawdownBps,
    maximumPossibleExposure: minimumExposure(mandate).toString(),
    staleReasons: Array.isArray(usage.staleReasons)
      ? usage.staleReasons.filter(
          (item): item is string => typeof item === "string",
        )
      : ["Usage projection is malformed"],
  };
}

function eventView(
  event: Awaited<ReturnType<typeof listTradingMandateEvents>>[number],
) {
  return {
    id: event.id,
    mandateId: event.mandateId,
    eventType: event.eventType,
    actorType: event.actorType as "HUMAN" | "SYSTEM",
    actorUserId: event.actorUserId,
    reasonCode: event.reasonCode,
    reason: event.reason,
    fromState: event.fromState,
    toState: event.toState,
    fingerprint: event.fingerprint,
    occurredAt: event.occurredAt.toISOString(),
  };
}

function decisionView(
  decision: Awaited<ReturnType<typeof listTradingMandateDecisions>>[number],
) {
  return {
    id: decision.id,
    mandateId: decision.mandateId,
    decisionFingerprint: decision.decisionFingerprint,
    riskFingerprint: decision.riskFingerprint,
    status: decision.status as
      | "CLAIMED"
      | "BOUNDARY_AUTHORIZED"
      | "EXECUTED"
      | "REFUSED"
      | "FAILED"
      | "OUTCOME_UNKNOWN",
    reasonCode: decision.reasonCode,
    reason: decision.reason,
    intentId: decision.executionIntentId,
    tradeId: decision.tradeId,
    createdAt: decision.createdAt.toISOString(),
  };
}

router.get("/trading-mandates", async (req, res): Promise<void> => {
  const identity = await getFinancialAuthorizationIdentity(req.userId!);
  if (!identity) {
    res.status(403).json({ error: "Financial role is unavailable" });
    return;
  }
  const currentSection = section(req);
  const [mandates, events, decisions, eligibleAccounts] = await Promise.all([
    listTradingMandates(req.userId!, currentSection),
    listTradingMandateEvents(req.userId!, currentSection),
    listTradingMandateDecisions(req.userId!, currentSection),
    resolveEligibleTradingAccounts(req.userId!, currentSection),
  ]);
  const activeMandate =
    mandates.find((mandate) => mandate.lifecycleState === "ACTIVE") ?? null;
  const usage = await usageView(activeMandate);
  res.json({
    authorityLabel: "RESTRICTED_LIVE",
    productionActivationRequired: true,
    role: identity.role,
    activeMandate,
    mandates,
    usage,
    events: events.map(eventView),
    decisions: decisions.map(decisionView),
    degradedReasons: [
      ...(eligibleAccounts.length === 0
        ? ["No eligible server-resolved Live account is configured"]
        : []),
      ...(activeMandate && usage?.status !== "CURRENT"
        ? ["Active mandate usage is unavailable or stale; entry fails closed"]
        : []),
    ],
    eligibleAccounts,
  });
});

router.get("/trading-mandates/:mandateId", async (req, res): Promise<void> => {
  try {
    const mandateId = Number(req.params.mandateId);
    const currentSection = section(req);
    const mandate = await getTradingMandateView({
      mandateId,
      userId: req.userId!,
      section: currentSection,
    });
    const [events, decisions, mandates, usage] = await Promise.all([
      listTradingMandateEvents(req.userId!, currentSection, mandateId),
      listTradingMandateDecisions(req.userId!, currentSection, mandateId),
      listTradingMandates(req.userId!, currentSection),
      usageView(mandate),
    ]);
    res.json({
      mandate,
      usage,
      events: events.map(eventView),
      decisions: decisions.map(decisionView),
      previousRevision:
        mandates.find((item) => item.id === mandate.replacesMandateId) ?? null,
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/trading-mandates", async (req, res): Promise<void> => {
  const authority = await requireMutationAuthority(req, res);
  if (!authority) return;
  const parsed = CreateTradingMandateBody.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({
        error: "Invalid TradingMandate terms",
        issues: parsed.error.issues,
      });
    return;
  }
  try {
    const mandate = await createTradingMandate({
      userId: req.userId!,
      section: section(req),
      clientRequestId: parsed.data.clientRequestId,
      expectedNextRevision: parsed.data.expectedNextRevision,
      replacesMandateId: parsed.data.replacesMandateId ?? null,
      changeReason: parsed.data.changeReason,
      terms: {
        ...parsed.data.terms,
        monetaryScale: 8,
        effectiveAt: parsed.data.terms.effectiveAt.toISOString(),
        expiresAt: parsed.data.terms.expiresAt.toISOString(),
      },
      actorUserId: req.userId!,
    });
    res.status(201).json(mandate);
  } catch (error) {
    handleError(res, error);
  }
});

router.post(
  "/trading-mandates/:mandateId/submit",
  async (req, res): Promise<void> => {
    const authority = await requireMutationAuthority(req, res);
    if (!authority) return;
    const parsed = SubmitTradingMandateBody.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid submit request", issues: parsed.error.issues });
      return;
    }
    try {
      res.json(
        await transitionTradingMandate({
          mandateId: Number(req.params.mandateId),
          userId: req.userId!,
          section: section(req),
          expectedRevision: parsed.data.expectedRevision,
          clientRequestId: parsed.data.clientRequestId,
          reason: parsed.data.reason,
          actorType: "HUMAN",
          actorUserId: req.userId!,
          action: "SUBMIT",
        }),
      );
    } catch (error) {
      handleError(res, error);
    }
  },
);

router.post(
  "/trading-mandates/:mandateId/approve",
  async (req, res): Promise<void> => {
    const authority = await requireMutationAuthority(req, res);
    if (!authority) return;
    const parsed = ApproveTradingMandateBody.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({
          error: "Invalid authorization request",
          issues: parsed.error.issues,
        });
      return;
    }
    const stepUp = await verifyFinancialStepUp(
      req,
      req.userId!,
      parsed.data.currentPassword,
    );
    if (!stepUp.ok) {
      res.status(403).json({ error: stepUp.reason });
      return;
    }
    try {
      const currentSection = section(req);
      const approved = await approveTradingMandate({
        mandateId: Number(req.params.mandateId),
        userId: req.userId!,
        section: currentSection,
        expectedRevision: parsed.data.expectedRevision,
        clientRequestId: parsed.data.clientRequestId,
        authorizationId: parsed.data.authorizationId,
        reason: parsed.data.reason,
        actorUserId: req.userId!,
        sessionVersion: authority.sessionVersion,
        authorizationMethod:
          req.authMethod === "basic" ? "BASIC_REAUTH" : "PASSWORD_STEP_UP",
      });
      logger.warn(
        {
          userId: req.userId,
          section: currentSection,
          mandateId: approved.id,
          revision: approved.revision,
        },
        "RESTRICTED_LIVE_MANDATE_AUTHORIZED_WITHOUT_DEPLOYMENT_OR_PROVIDER_CHANGE",
      );
      res.json(approved);
    } catch (error) {
      handleError(res, error);
    }
  },
);

for (const action of ["suspend", "revoke"] as const) {
  router.post(
    `/trading-mandates/:mandateId/${action}`,
    async (req, res): Promise<void> => {
      const authority = await requireMutationAuthority(req, res);
      if (!authority) return;
      const schema =
        action === "suspend"
          ? SuspendTradingMandateBody
          : RevokeTradingMandateBody;
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        res
          .status(400)
          .json({
            error: `Invalid ${action} request`,
            issues: parsed.error.issues,
          });
        return;
      }
      try {
        res.json(
          await transitionTradingMandate({
            mandateId: Number(req.params.mandateId),
            userId: req.userId!,
            section: section(req),
            expectedRevision: parsed.data.expectedRevision,
            clientRequestId: parsed.data.clientRequestId,
            reason: parsed.data.reason,
            actorType: "HUMAN",
            actorUserId: req.userId!,
            action: action === "suspend" ? "SUSPEND" : "REVOKE",
          }),
        );
      } catch (error) {
        handleError(res, error);
      }
    },
  );
}

export default router;
