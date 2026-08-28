import { Router, type IRouter, type Request, type Response } from "express";
import {
  autopilotControlsTable,
  botConfigTable,
  brainVersionsTable,
  db,
  executionIntentsTable,
  liveExecutionStatesTable,
  liveKillSwitchesTable,
  liveSafetyEventsTable,
  platformAuditEventsTable,
  platformRoleAssignmentsTable,
  usersTable,
} from "@workspace/db";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  lt,
  ne,
  sql,
} from "drizzle-orm";
import { z } from "zod/v4";
import {
  activePlatformRoles,
  auditFailureBestEffort,
  clearAdminStepUp,
  issueAdminStepUp,
  permissionsForRoles,
  recordPlatformAudit,
  requestId,
  requireAdminStepUp,
  requirePlatformPermission,
  verifyAdminStepUp,
} from "../lib/platformAdmin";
import { getEngineResumeHealth } from "../lib/startupHealth";
import {
  approvePlatformAutopilotResume,
  getPlatformAutopilotSafetyState,
  requestPlatformAutopilotResume,
  suspendPlatformAutopilot,
} from "../lib/platformAutopilotSafety";
import { verifyFinancialRequestOrigin } from "../middleware/financialRequest";
import {
  BRAIN_V0_CONTROL_COMMIT,
  BRAIN_V0_VERSION,
} from "../lib/intelligence/baseline";

const router: IRouter = Router();

function maskedEmail(value: string | null): string | null {
  if (!value) return null;
  const at = value.indexOf("@");
  if (at <= 0) return "••••";
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  return `${local.slice(0, 1)}${"•".repeat(Math.min(4, Math.max(1, local.length - 1)))}@${domain}`;
}

router.get("/admin/session/status", async (req, res): Promise<void> => {
  const roles = await activePlatformRoles(req.userId!);
  const permissions = permissionsForRoles(roles);
  const stepUp = await verifyAdminStepUp(req);
  res.json({
    eligible: roles.length > 0,
    roles,
    permissions,
    stepUp: stepUp.ok
      ? { active: true, expiresAt: stepUp.expiresAt }
      : { active: false, expiresAt: null, reason: stepUp.reason },
    mutationsSupported: permissions.includes("admin.risk.suspend"),
    mutationReason:
      "Demo AutoPilot safety controls require recent Admin step-up, explicit confirmation, an audit reason, and two distinct qualified operators for resume.",
  });
});

const AdminStepUpBody = z
  .object({ password: z.string().min(1).max(1024) })
  .strict();

router.post("/admin/session/step-up", async (req, res): Promise<void> => {
  const parsed = AdminStepUpBody.safeParse(req.body);
  const id = requestId(req);
  if (!parsed.success) {
    res
      .status(400)
      .json({
        error: "Current password is required",
        code: "ADMIN_STEP_UP_INVALID",
      });
    return;
  }
  const result = await issueAdminStepUp({
    req,
    res,
    password: parsed.data.password,
  });
  if (!result.ok) {
    auditFailureBestEffort({
      actorUserId: req.userId ?? null,
      permission: "admin.session.step-up",
      action: "ADMIN_STEP_UP",
      targetType: "admin_session",
      targetId: req.userId ? String(req.userId) : null,
      requestId: id,
      result: "REFUSED",
      reason: result.reason,
    });
    res
      .status(403)
      .json({ error: result.reason, code: "ADMIN_STEP_UP_REFUSED" });
    return;
  }
  await recordPlatformAudit({
    actorUserId: req.userId!,
    permission: "admin.session.step-up",
    action: "ADMIN_STEP_UP",
    targetType: "admin_session",
    targetId: String(req.userId),
    requestId: id,
    result: "SUCCEEDED",
    metadata: { roles: result.roles, expiresAt: result.expiresAt },
  });
  res.json({ ok: true, roles: result.roles, expiresAt: result.expiresAt });
});

router.post("/admin/session/logout", (req, res): void => {
  clearAdminStepUp(res);
  res.json({ ok: true });
});

router.use("/admin", requireAdminStepUp);
router.use("/admin", (req, res, next): void => {
  if (
    req.method === "GET" ||
    req.method === "HEAD" ||
    req.method === "OPTIONS"
  ) {
    next();
    return;
  }
  const origin = verifyFinancialRequestOrigin(req);
  if (!origin.ok) {
    res.status(403).json({ error: origin.reason, code: "ORIGIN_REJECTED" });
    return;
  }
  next();
});

router.get(
  "/admin/overview",
  requirePlatformPermission("admin.overview.read"),
  async (_req, res): Promise<void> => {
    const [
      users,
      configuredSections,
      desiredRuntimes,
      unresolved,
      switches,
      controls,
    ] = await Promise.all([
      db.select({ count: count() }).from(usersTable),
      db.select({ count: count() }).from(botConfigTable),
      db
        .select({ count: count() })
        .from(botConfigTable)
        .where(eq(botConfigTable.engineDesiredRunning, true)),
      db
        .select({ count: count() })
        .from(executionIntentsTable)
        .where(
          inArray(executionIntentsTable.state, [
            "ORDER_SUBMITTED",
            "PARTIALLY_FILLED",
            "FILLED",
            "RECORDED",
            "RECONCILIATION_REQUIRED",
            "ESCALATED",
          ]),
        ),
      db
        .select({ count: count() })
        .from(liveKillSwitchesTable)
        .where(eq(liveKillSwitchesTable.active, true)),
      db
        .select({ state: autopilotControlsTable.state, count: count() })
        .from(autopilotControlsTable)
        .groupBy(autopilotControlsTable.state),
    ]);
    const unresolvedCount = unresolved[0]?.count ?? 0;
    const activeSwitches = switches[0]?.count ?? 0;
    res.json({
      asOf: new Date().toISOString(),
      status:
        unresolvedCount > 0 || activeSwitches > 0
          ? "ATTENTION_REQUIRED"
          : "OPERATIONAL",
      counts: {
        users: users[0]?.count ?? 0,
        configuredSections: configuredSections[0]?.count ?? 0,
        desiredRuntimes: desiredRuntimes[0]?.count ?? 0,
        unresolvedExecutionIntents: unresolvedCount,
        activeSafetySwitches: activeSwitches,
      },
      autopilot: Object.fromEntries(
        controls.map((row) => [row.state, row.count]),
      ),
      authorityBoundary:
        "Platform visibility does not grant tenant financial authority or broker access.",
    });
  },
);

router.get(
  "/admin/health",
  requirePlatformPermission("admin.health.read"),
  async (req, res): Promise<void> => {
    const started = performance.now();
    let database: {
      state: "HEALTHY" | "UNREACHABLE";
      latencyMs: number | null;
    };
    try {
      await db.execute(sql`select 1`);
      database = {
        state: "HEALTHY",
        latencyMs: Math.round((performance.now() - started) * 10) / 10,
      };
    } catch {
      database = { state: "UNREACHABLE", latencyMs: null };
    }
    const memory = process.memoryUsage();
    res.json({
      asOf: new Date().toISOString(),
      services: {
        api: { state: "HEALTHY", uptimeSeconds: Math.floor(process.uptime()) },
        database,
        workers: {
          state: getEngineResumeHealth().status.toUpperCase(),
          engineResume: getEngineResumeHealth(),
        },
        queues: {
          state: "NOT_PROVISIONED",
          reason: "This architecture has no general queue subsystem.",
        },
        brokers: {
          state: "NOT_PROVISIONED",
          reason:
            "A platform-wide broker connectivity projection does not exist; tenant runtimes retain their own connection evidence.",
        },
        marketData: {
          state: "NOT_PROVISIONED",
          reason:
            "A platform-wide market-data health projection does not exist in this baseline.",
        },
      },
      resources: {
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
      },
    });
  },
);

router.get(
  "/admin/ai",
  requirePlatformPermission("admin.ai.read"),
  async (_req, res): Promise<void> => {
    const versions = await db
      .select({
        version: brainVersionsTable.version,
        implementation: brainVersionsTable.implementation,
        state: brainVersionsTable.state,
        fingerprint: brainVersionsTable.fingerprint,
        sourceCommit: brainVersionsTable.sourceCommit,
        assignments: count(),
      })
      .from(brainVersionsTable)
      .groupBy(
        brainVersionsTable.version,
        brainVersionsTable.implementation,
        brainVersionsTable.state,
        brainVersionsTable.fingerprint,
        brainVersionsTable.sourceCommit,
      )
      .orderBy(asc(brainVersionsTable.version));
    res.json({
      asOf: new Date().toISOString(),
      deterministicBrain: {
        supported: true,
        controlVersion: BRAIN_V0_VERSION,
        controlCommit: BRAIN_V0_CONTROL_COMMIT,
        versions,
      },
      externalProviders: {
        supported: false,
        providers: [],
        reason:
          "No external AI-provider adapter, model router, usage meter, or platform SecretStore contract exists in this baseline.",
      },
      mutationsSupported: false,
    });
  },
);

router.get(
  "/admin/execution",
  requirePlatformPermission("admin.execution.read"),
  async (_req, res): Promise<void> => {
    const unresolvedStates = [
      "ORDER_SUBMITTED",
      "PARTIALLY_FILLED",
      "FILLED",
      "RECORDED",
      "RECONCILIATION_REQUIRED",
      "ESCALATED",
    ];
    const [intents, states] = await Promise.all([
      db
        .select({
          id: executionIntentsTable.id,
          userId: executionIntentsTable.userId,
          section: executionIntentsTable.section,
          symbol: executionIntentsTable.symbol,
          state: executionIntentsTable.state,
          marketType: executionIntentsTable.marketType,
          strategyId: executionIntentsTable.strategyId,
          resolutionCode: executionIntentsTable.resolutionCode,
          createdAt: executionIntentsTable.createdAt,
          lastReconciledAt: executionIntentsTable.lastReconciledAt,
        })
        .from(executionIntentsTable)
        .where(inArray(executionIntentsTable.state, unresolvedStates))
        .orderBy(desc(executionIntentsTable.createdAt))
        .limit(100),
      db
        .select({
          userId: liveExecutionStatesTable.userId,
          section: liveExecutionStatesTable.section,
          operatingMode: liveExecutionStatesTable.operatingMode,
          reconciliationState: liveExecutionStatesTable.reconciliationState,
          protectionState: liveExecutionStatesTable.protectionState,
          accountDrawdownState: liveExecutionStatesTable.accountDrawdownState,
          globalDrawdownState: liveExecutionStatesTable.globalDrawdownState,
          entryBlockReason: liveExecutionStatesTable.entryBlockReason,
          lastReconciledAt: liveExecutionStatesTable.lastReconciledAt,
          updatedAt: liveExecutionStatesTable.updatedAt,
        })
        .from(liveExecutionStatesTable)
        .orderBy(desc(liveExecutionStatesTable.updatedAt))
        .limit(200),
    ]);
    res.json({
      asOf: new Date().toISOString(),
      unresolvedIntents: intents.map((row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
        lastReconciledAt: row.lastReconciledAt?.toISOString() ?? null,
      })),
      accountStates: states.map((row) => ({
        ...row,
        lastReconciledAt: row.lastReconciledAt?.toISOString() ?? null,
        updatedAt: row.updatedAt.toISOString(),
      })),
      controlsSupported: false,
      authorityBoundary:
        "This read model does not grant recovery, trading, mandate, or provider authority.",
    });
  },
);

router.get(
  "/admin/risk",
  requirePlatformPermission("admin.risk.read"),
  async (req, res): Promise<void> => {
    const [switches, incidents, platformAutopilot] = await Promise.all([
      db
        .select({
          id: liveKillSwitchesTable.id,
          ownerUserId: liveKillSwitchesTable.ownerUserId,
          section: liveKillSwitchesTable.section,
          scope: liveKillSwitchesTable.scope,
          scopeKey: liveKillSwitchesTable.scopeKey,
          reason: liveKillSwitchesTable.reason,
          activatedByUserId: liveKillSwitchesTable.activatedByUserId,
          activatedAt: liveKillSwitchesTable.activatedAt,
        })
        .from(liveKillSwitchesTable)
        .where(eq(liveKillSwitchesTable.active, true))
        .orderBy(desc(liveKillSwitchesTable.activatedAt))
        .limit(200),
      db
        .select({
          id: liveSafetyEventsTable.id,
          targetUserId: liveSafetyEventsTable.targetUserId,
          section: liveSafetyEventsTable.section,
          eventType: liveSafetyEventsTable.eventType,
          actorType: liveSafetyEventsTable.actorType,
          actorUserId: liveSafetyEventsTable.actorUserId,
          reasonCode: liveSafetyEventsTable.reasonCode,
          reason: liveSafetyEventsTable.reason,
          occurredAt: liveSafetyEventsTable.occurredAt,
        })
        .from(liveSafetyEventsTable)
        .orderBy(desc(liveSafetyEventsTable.occurredAt))
        .limit(200),
      getPlatformAutopilotSafetyState(),
    ]);
    res.json({
      asOf: new Date().toISOString(),
      activeSwitches: switches.map((row) => ({
        ...row,
        source: row.ownerUserId === 0 ? "PLATFORM" : "TENANT",
        activatedAt: row.activatedAt.toISOString(),
      })),
      incidents: incidents.map((row) => ({
        ...row,
        source: row.targetUserId === 0 ? "PLATFORM" : "TENANT",
        occurredAt: row.occurredAt.toISOString(),
      })),
      platformAutopilot: {
        ...platformAutopilot,
        pendingResume: platformAutopilot.pendingResume
          ? {
              ...platformAutopilot.pendingResume,
              canCurrentOperatorApprove:
                platformAutopilot.pendingResume.requestedByUserId !==
                req.userId,
            }
          : null,
      },
      controlsSupported: true,
      controlsReason:
        "Suspension is immediate. Resume requires a time-limited request and approval by a second distinct qualified operator. These controls apply only to Demo/testnet/practice AutoPilot; Live authority remains unavailable.",
    });
  },
);

const AdminSafetyReason = z.string().trim().min(8).max(500);
const RequestAutopilotResumeBody = z
  .object({
    reason: AdminSafetyReason,
    clientRequestId: z.string().uuid(),
    confirmation: z.literal("REQUEST_PLATFORM_AUTOPILOT_RESUME"),
  })
  .strict();
const ApproveAutopilotResumeBody = z
  .object({
    reason: AdminSafetyReason,
    resumeRequestId: z.string().uuid(),
    confirmation: z.literal("APPROVE_PLATFORM_AUTOPILOT_RESUME"),
  })
  .strict();
const SuspendAutopilotBody = z
  .object({
    reason: AdminSafetyReason,
    confirmation: z.literal("SUSPEND_PLATFORM_AUTOPILOT"),
  })
  .strict();

function adminSafetyError(
  req: Request,
  res: Response,
  error: unknown,
  permission: string,
  action: string,
): void {
  const reason =
    error instanceof Error ? error.message : "Safety action was refused";
  auditFailureBestEffort({
    actorUserId: req.userId ?? null,
    permission,
    action,
    targetType: "platform_autopilot_safety",
    targetId: "global",
    requestId: requestId(req),
    result: "REFUSED",
    reason,
  });
  res.status(409).json({ error: reason, code: "ADMIN_SAFETY_ACTION_REFUSED" });
}

router.post(
  "/admin/risk/autopilot/resume-requests",
  requirePlatformPermission("admin.risk.resume.request"),
  async (req, res): Promise<void> => {
    const parsed = RequestAutopilotResumeBody.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({
          error: "A valid reason, request ID, and confirmation are required",
          code: "ADMIN_SAFETY_INPUT_INVALID",
        });
      return;
    }
    try {
      const state = await requestPlatformAutopilotResume({
        actorUserId: req.userId!,
        reason: parsed.data.reason,
        clientRequestId: parsed.data.clientRequestId,
        auditRequestId: requestId(req),
      });
      res.status(201).json(state);
    } catch (error) {
      adminSafetyError(
        req,
        res,
        error,
        "admin.risk.resume.request",
        "REQUEST_PLATFORM_AUTOPILOT_RESUME",
      );
    }
  },
);

router.post(
  "/admin/risk/autopilot/resume-approvals",
  requirePlatformPermission("admin.risk.resume.approve"),
  async (req, res): Promise<void> => {
    const parsed = ApproveAutopilotResumeBody.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({
          error: "A valid request ID, reason, and confirmation are required",
          code: "ADMIN_SAFETY_INPUT_INVALID",
        });
      return;
    }
    try {
      res.json(
        await approvePlatformAutopilotResume({
          actorUserId: req.userId!,
          resumeRequestId: parsed.data.resumeRequestId,
          reason: parsed.data.reason,
          auditRequestId: requestId(req),
        }),
      );
    } catch (error) {
      adminSafetyError(
        req,
        res,
        error,
        "admin.risk.resume.approve",
        "APPROVE_PLATFORM_AUTOPILOT_RESUME",
      );
    }
  },
);

router.post(
  "/admin/risk/autopilot/suspend",
  requirePlatformPermission("admin.risk.suspend"),
  async (req, res): Promise<void> => {
    const parsed = SuspendAutopilotBody.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({
          error: "A valid reason and confirmation are required",
          code: "ADMIN_SAFETY_INPUT_INVALID",
        });
      return;
    }
    try {
      res.json(
        await suspendPlatformAutopilot({
          actorUserId: req.userId!,
          reason: parsed.data.reason,
          auditRequestId: requestId(req),
        }),
      );
    } catch (error) {
      adminSafetyError(
        req,
        res,
        error,
        "admin.risk.suspend",
        "SUSPEND_PLATFORM_AUTOPILOT",
      );
    }
  },
);

const UserQuery = z.object({
  afterId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

router.get(
  "/admin/users",
  requirePlatformPermission("admin.users.read"),
  async (req, res): Promise<void> => {
    const parsed = UserQuery.safeParse(req.query);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid pagination", code: "ADMIN_QUERY_INVALID" });
      return;
    }
    const rows = await db
      .select({
        id: usersTable.id,
        username: usersTable.username,
        displayName: usersTable.displayName,
        email: usersTable.email,
        isDemo: usersTable.isDemo,
        financialRole: usersTable.financialRole,
        createdAt: usersTable.createdAt,
      })
      .from(usersTable)
      .where(
        parsed.data.afterId
          ? gt(usersTable.id, parsed.data.afterId)
          : undefined,
      )
      .orderBy(asc(usersTable.id))
      .limit(parsed.data.limit + 1);
    const page = rows.slice(0, parsed.data.limit);
    const ids = page.map((row) => row.id);
    const roles = ids.length
      ? await db
          .select({
            userId: platformRoleAssignmentsTable.userId,
            role: platformRoleAssignmentsTable.role,
            status: platformRoleAssignmentsTable.status,
          })
          .from(platformRoleAssignmentsTable)
          .where(inArray(platformRoleAssignmentsTable.userId, ids))
      : [];
    const rolesByUser = new Map<number, string[]>();
    for (const role of roles) {
      if (role.status !== "ACTIVE") continue;
      const current = rolesByUser.get(role.userId) ?? [];
      current.push(role.role);
      rolesByUser.set(role.userId, current);
    }
    await recordPlatformAudit({
      actorUserId: req.userId!,
      permission: "admin.users.read",
      action: "LIST_USERS",
      targetType: "user_directory",
      requestId: requestId(req),
      result: "SUCCEEDED",
      metadata: { returned: page.length, afterId: parsed.data.afterId ?? null },
    });
    res.json({
      users: page.map((row) => ({
        id: row.id,
        username: row.username,
        displayName: row.displayName,
        maskedEmail: maskedEmail(row.email),
        isDemo: row.isDemo,
        financialRole: row.financialRole,
        platformRoles: rolesByUser.get(row.id) ?? [],
        accessState: "ACTIVE",
        createdAt: row.createdAt.toISOString(),
      })),
      nextAfterId:
        rows.length > parsed.data.limit ? (page.at(-1)?.id ?? null) : null,
      mutationsSupported: false,
    });
  },
);

const AuditQuery = z.object({
  beforeId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

router.get(
  "/admin/audit",
  requirePlatformPermission("admin.audit.read"),
  async (req, res): Promise<void> => {
    const parsed = AuditQuery.safeParse(req.query);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid pagination", code: "ADMIN_QUERY_INVALID" });
      return;
    }
    const rows = await db
      .select()
      .from(platformAuditEventsTable)
      .where(
        parsed.data.beforeId
          ? lt(platformAuditEventsTable.id, parsed.data.beforeId)
          : undefined,
      )
      .orderBy(desc(platformAuditEventsTable.id))
      .limit(parsed.data.limit + 1);
    const page = rows.slice(0, parsed.data.limit);
    await recordPlatformAudit({
      actorUserId: req.userId!,
      permission: "admin.audit.read",
      action: "READ_AUDIT",
      targetType: "platform_audit",
      requestId: requestId(req),
      result: "SUCCEEDED",
      metadata: {
        returned: page.length,
        beforeId: parsed.data.beforeId ?? null,
      },
    });
    res.json({
      events: page.map((row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
      })),
      nextBeforeId:
        rows.length > parsed.data.limit ? (page.at(-1)?.id ?? null) : null,
      appendOnly: true,
    });
  },
);

router.get(
  "/admin/configuration",
  requirePlatformPermission("admin.configuration.read"),
  (_req, res): void => {
    res.json({
      asOf: new Date().toISOString(),
      capabilities: {
        externalAiProviders: false,
        secretStore: false,
        generalQueue: false,
        multipleBrokerAccounts: false,
        adminMutations: false,
        manualTrading: false,
      },
      supported: {
        deterministicBrain: true,
        tenantExecutionHealth: true,
        immutableDemoAutopilotMandates: true,
        restrictedLiveMandates: true,
        platformReadOnlyOperations: true,
      },
      notice:
        "Unavailable infrastructure is intentionally reported as unsupported rather than inferred healthy.",
    });
  },
);

export default router;
