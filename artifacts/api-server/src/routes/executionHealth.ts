import { Router, type IRouter } from "express";
import {
  ApplyExecutionIntentActionBody,
  ApplyExecutionIntentActionParams,
  SetExecutionOperatingModeBody,
} from "@workspace/api-zod";
import {
  verifyFinancialRequestOrigin,
  verifyFinancialStepUp,
} from "../middleware/auth";
import { getOrCreateEngine } from "../lib/engineRegistry";
import {
  applyOperatorReconciliationAction,
  getLiveExecutionHealth,
  ReconciliationActionError,
  setOperatorLiveMode,
} from "../lib/execution/liveSafetyStore";
import { evaluateDrawdown } from "../lib/execution/liveSafety";

const router: IRouter = Router();

function mapHealth(
  persisted: Awaited<ReturnType<typeof getLiveExecutionHealth>>,
  runtime: ReturnType<ReturnType<typeof getOrCreateEngine>["getState"]>,
) {
  const recentCount = (
    predicate: (eventType: string, reasonCode: string) => boolean,
  ) =>
    persisted.incidents.filter((event) =>
      predicate(event.eventType, event.reasonCode),
    ).length;
  const parseMinor = (value: string | null): bigint | null =>
    value !== null && /^-?\d+$/.test(value) ? BigInt(value) : null;
  const accountFresh =
    persisted.state.equityFreshUntil !== null &&
    persisted.state.equityFreshUntil.getTime() > Date.now();
  const accountDrawdown = evaluateDrawdown({
    peakEquityMinor: accountFresh
      ? parseMinor(persisted.state.peakEquityMinor)
      : null,
    currentEquityMinor: accountFresh
      ? parseMinor(persisted.state.currentEquityMinor)
      : null,
    limitBps: persisted.state.accountDrawdownLimitBps,
  });
  const globalFresh =
    persisted.globalState?.freshUntil !== null &&
    persisted.globalState?.freshUntil !== undefined &&
    persisted.globalState.freshUntil.getTime() > Date.now();
  const globalDrawdownState = globalFresh
    ? persisted.globalState!.drawdownState
    : "UNKNOWN";
  return {
    status:
      persisted.state.operatingMode === "NORMAL" &&
      persisted.state.reconciliationState === "HEALTHY" &&
      persisted.state.protectionState === "HEALTHY" &&
      globalDrawdownState === "HEALTHY" &&
      accountDrawdown.state === "HEALTHY" &&
      persisted.switches.length === 0 &&
      persisted.unresolvedIntents.length === 0
        ? "HEALTHY"
        : "BLOCKED",
    operatingMode: persisted.state.operatingMode,
    operatingModeSource: persisted.state.operatingModeSource,
    reconciliationState: persisted.state.reconciliationState,
    protectionState: persisted.state.protectionState,
    globalDrawdownState,
    accountDrawdownState: accountDrawdown.state,
    entryBlockReason: persisted.state.entryBlockReason,
    ownershipGeneration: persisted.state.ownershipGeneration,
    ownerClaimedAt: persisted.state.ownerClaimedAt?.toISOString() ?? null,
    lastReconciledAt: persisted.state.lastReconciledAt?.toISOString() ?? null,
    lastIncidentAt: persisted.state.lastIncidentAt?.toISOString() ?? null,
    currentEquityMinor: persisted.state.currentEquityMinor,
    peakEquityMinor: persisted.state.peakEquityMinor,
    equitySource: persisted.state.equitySource,
    equityObservedAt: persisted.state.equityObservedAt?.toISOString() ?? null,
    equityFreshUntil: persisted.state.equityFreshUntil?.toISOString() ?? null,
    globalCurrentEquityMinor: persisted.globalState?.currentEquityMinor ?? null,
    globalPeakEquityMinor: persisted.globalState?.peakEquityMinor ?? null,
    globalEquityObservedAt:
      persisted.globalState?.observedAt?.toISOString() ?? null,
    globalEquityFreshUntil:
      persisted.globalState?.freshUntil?.toISOString() ?? null,
    globalEquitySourceCount: persisted.globalState?.sourceCount ?? 0,
    accountDrawdownLimitBps: persisted.state.accountDrawdownLimitBps,
    globalDrawdownLimitBps: persisted.state.globalDrawdownLimitBps,
    runtime: {
      running: runtime.running,
      newEntriesAllowed: runtime.newEntriesAllowed,
      entryBlockReason: runtime.entryBlockReason,
      openPositions: runtime.openPositions,
      lastScanAt: runtime.lastScanAt,
    },
    activeSwitches: persisted.switches.map((row) => ({
      scope: row.scope,
      scopeKey: row.scopeKey,
      reason: row.reason,
      activatedAt: row.activatedAt.toISOString(),
      source: row.ownerUserId === 0 ? "PLATFORM" : "USER",
    })),
    unresolvedIntents: persisted.unresolvedIntents.map((intent) => ({
      id: intent.id,
      symbol: intent.symbol,
      state: intent.state,
      clientOrderId: intent.clientOrderId,
      resolutionCode: intent.resolutionCode,
      filledQuantity: intent.filledQuantity,
      averageFillPrice: intent.averageFillPrice,
      brokerOrderId: intent.brokerOrderId,
      brokerTradeId: intent.brokerTradeId,
      recoveryClientOrderId: intent.recoveryClientOrderId,
      recoveryState: intent.recoveryState,
      recoveryBrokerOrderId: intent.recoveryBrokerOrderId,
      recoveryAttemptedAt: intent.recoveryAttemptedAt?.toISOString() ?? null,
      createdAt: intent.createdAt.toISOString(),
      lastReconciledAt: intent.lastReconciledAt?.toISOString() ?? null,
    })),
    metrics: {
      unresolvedIntents: persisted.unresolvedIntents.length,
      reconciliationFailures: recentCount(
        (eventType) =>
          eventType === "RECONCILIATION_BLOCKED" ||
          eventType === "EXPOSURE_RECOVERY_ESCALATED" ||
          eventType === "EXPOSURE_RECOVERY_RETRY_REQUIRED",
      ),
      recoveredExposure: recentCount(
        (eventType) => eventType === "RECOVERED_EXPOSURE_FLATTENED",
      ),
      protectionFailures: recentCount(
        (eventType, reasonCode) =>
          eventType.includes("PROTECTION") || reasonCode.includes("PROTECTION"),
      ),
      activeKillSwitches: persisted.switches.length,
      operatingModeChanges: recentCount(
        (eventType) => eventType === "OPERATING_MODE_CHANGED",
      ),
      drawdownBreaches: recentCount((_eventType, reasonCode) =>
        reasonCode.endsWith("_BREACHED"),
      ),
      ownershipChanges: recentCount(
        (eventType) => eventType === "OWNERSHIP_CLAIMED",
      ),
      criticalAlerts: recentCount(
        (eventType) => eventType === "CRITICAL_OPERATOR_ALERT",
      ),
    },
    incidents: persisted.incidents.map((event) => ({
      id: event.id,
      eventType: event.eventType,
      reasonCode: event.reasonCode,
      reason: event.reason,
      actorType: event.actorType,
      occurredAt: event.occurredAt.toISOString(),
      source: event.targetUserId === 0 ? "PLATFORM" : "USER",
    })),
  };
}

router.get("/execution-health", async (req, res): Promise<void> => {
  const engine = getOrCreateEngine(req.userId!, req.section!, {
    resumeIdleDemo: false,
  });
  const persisted = await getLiveExecutionHealth(req.userId!, req.section!);
  res.json(mapHealth(persisted, engine.getState()));
});

router.post("/execution-health/mode", async (req, res): Promise<void> => {
  const origin = verifyFinancialRequestOrigin(req);
  if (!origin.ok) {
    res
      .status(403)
      .json({ error: origin.reason, code: "FINANCIAL_ORIGIN_REFUSED" });
    return;
  }
  const parsed = SetExecutionOperatingModeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid execution-health control request",
      code: "LIVE_CONTROL_REQUEST_INVALID",
    });
    return;
  }
  const body = parsed.data;
  const action = body.action;
  const mode =
    action === "STOP_NEW_TRADES"
      ? "NO_NEW_ENTRY"
      : action === "EXIT_ONLY"
        ? "EXIT_ONLY"
        : null;
  const confirmation =
    action === "STOP_NEW_TRADES" ? "STOP NEW TRADES" : "EXIT ONLY";
  if (!mode || body.confirmation !== confirmation) {
    res.status(400).json({
      error: "Action and exact confirmation phrase are required",
      code: "LIVE_CONTROL_CONFIRMATION_REQUIRED",
    });
    return;
  }
  const reason = body.reason.trim();
  if (reason.length < 8 || reason.length > 500) {
    res.status(400).json({
      error: "Reason must contain between 8 and 500 characters",
      code: "LIVE_CONTROL_REASON_REQUIRED",
    });
    return;
  }
  const stepUp = await verifyFinancialStepUp(req, req.userId!, body.password);
  if (!stepUp.ok) {
    res.status(403).json({ error: stepUp.reason, code: "STEP_UP_REQUIRED" });
    return;
  }
  await setOperatorLiveMode({
    userId: req.userId!,
    section: req.section!,
    mode,
    reason,
  });
  const engine = getOrCreateEngine(req.userId!, req.section!, {
    resumeIdleDemo: false,
  });
  engine.blockNewEntries(`Operator ${action}: ${reason}`);
  const persisted = await getLiveExecutionHealth(req.userId!, req.section!);
  req.log.warn(
    { userId: req.userId, section: req.section, action },
    "LIVE operating mode reduced by authenticated operator",
  );
  res.json(mapHealth(persisted, engine.getState()));
});

router.post(
  "/execution-health/intents/:intentId/action",
  async (req, res): Promise<void> => {
    const origin = verifyFinancialRequestOrigin(req);
    if (!origin.ok) {
      res
        .status(403)
        .json({ error: origin.reason, code: "FINANCIAL_ORIGIN_REFUSED" });
      return;
    }
    const params = ApplyExecutionIntentActionParams.safeParse(req.params);
    const parsed = ApplyExecutionIntentActionBody.safeParse(req.body);
    if (!params.success || !parsed.success) {
      res.status(400).json({
        error: "Invalid evidence-backed reconciliation action",
        code: "RECONCILIATION_ACTION_INVALID",
      });
      return;
    }
    const body = parsed.data;
    const confirmation =
      body.action === "RETRY_RECOVERY"
        ? "RETRY RECOVERY"
        : "ACKNOWLEDGE BLOCKED";
    if (body.confirmation !== confirmation) {
      res.status(400).json({
        error: "The exact action confirmation phrase is required",
        code: "RECONCILIATION_ACTION_CONFIRMATION_REQUIRED",
      });
      return;
    }
    const stepUp = await verifyFinancialStepUp(req, req.userId!, body.password);
    if (!stepUp.ok) {
      res.status(403).json({ error: stepUp.reason, code: "STEP_UP_REQUIRED" });
      return;
    }
    try {
      await applyOperatorReconciliationAction({
        userId: req.userId!,
        section: req.section!,
        intentId: params.data.intentId,
        ownershipGeneration: body.ownershipGeneration,
        action: body.action,
        idempotencyKey: body.idempotencyKey,
        reason: body.reason.trim(),
      });
      const engine = getOrCreateEngine(req.userId!, req.section!, {
        resumeIdleDemo: false,
      });
      engine.blockNewEntries(
        `Operator reconciliation action ${body.action}: ${body.reason.trim()}`,
      );
      if (body.action === "RETRY_RECOVERY") {
        await engine.requestLiveReconciliation("operator recovery retry");
      }
      const persisted = await getLiveExecutionHealth(req.userId!, req.section!);
      req.log.warn(
        {
          userId: req.userId,
          section: req.section,
          intentId: params.data.intentId,
          action: body.action,
        },
        "Evidence-backed reconciliation action recorded",
      );
      res.json(mapHealth(persisted, engine.getState()));
    } catch (error) {
      if (error instanceof ReconciliationActionError) {
        const status = error.code === "INTENT_NOT_FOUND" ? 404 : 409;
        res.status(status).json({ error: error.message, code: error.code });
        return;
      }
      throw error;
    }
  },
);

export default router;
