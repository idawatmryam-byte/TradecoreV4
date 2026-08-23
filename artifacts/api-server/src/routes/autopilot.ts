import { Router, type IRouter, type Response } from "express";
import { z } from "zod";
import { getOrCreateEngine } from "../lib/engineRegistry";
import { resolveExecutionAuthority } from "../lib/execution/authority";
import { loadStrategyConfigs } from "../lib/strategyConfigLoader";
import {
  DemoAutopilotAuthoritySchema,
  Phase7MandateActionSchema,
  TradingWindowSchema,
} from "../lib/autopilot/contracts";
import { autopilotConfigFingerprint, strategyConfigVersion } from "../lib/autopilot/fingerprints";
import {
  createMandate,
  ensureBrainV0Version,
  getAutopilotSnapshot,
  globalAutopilotSuspended,
  listAutopilotEvents,
  listBrainVersions,
  listMandates,
  nextMandateVersion,
  registerBrainVersion,
  refuseAutopilotActivationWhileGloballySuspended,
  revokeMandate,
  setAutopilotState,
  transitionBrainVersion,
} from "../lib/autopilot/store";
import { buildForwardSoakReport } from "../lib/autopilot/forwardSoak";
import { verifyFinancialRequestOrigin } from "../middleware/auth";

const router: IRouter = Router();

router.use("/autopilot", (req, res, next): void => {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") { next(); return; }
  const origin = verifyFinancialRequestOrigin(req);
  if (!origin.ok) {
    res.status(403).json({ error: origin.reason, code: "ORIGIN_REJECTED" });
    return;
  }
  next();
});

const reasonSchema = z.string().trim().min(8).max(1000);
const registerVersionSchema = z.object({
  version: z.string().trim().min(1).max(120),
  implementation: z.string().trim().min(1).max(120),
  sourceCommit: z.string().regex(/^[a-f0-9]{7,64}$/i),
  evidenceReferences: z.array(z.string().trim().min(1).max(300)).min(1).max(50),
  confirmation: z.literal("REGISTER_BRAIN_VERSION_WITHOUT_AUTHORITY"),
}).strict();

const transitionVersionSchema = z.object({
  toState: z.enum(["RESEARCH", "SHADOW", "COPILOT", "DEMO_APPROVED", "SUSPENDED", "RETIRED"]),
  reason: reasonSchema,
  confirmation: z.string(),
}).strict();

const mandateSchema = z.object({
  brainVersionId: z.number().int().positive(),
  instruments: z.array(z.string().trim().min(1).max(80)).min(1).max(200),
  strategyIds: z.array(z.string().trim().min(1).max(120)).min(1).max(100),
  maximumPositionSizeUsdt: z.number().finite().positive(),
  maximumLeverage: z.number().int().min(1).max(125),
  maximumPortfolioRiskPercent: z.number().finite().positive().max(100),
  maximumSymbolExposurePercent: z.number().finite().positive().max(1000),
  maximumNetExposurePercent: z.number().finite().positive().max(1000),
  maximumCorrelatedExposurePercent: z.number().finite().positive().max(1000),
  dailyLossLimitUsdt: z.number().finite().positive(),
  maximumDrawdownPercent: z.number().finite().positive().max(100),
  maximumConcurrentPositions: z.number().int().positive().max(1000),
  maximumMarketDataAgeSeconds: z.number().int().positive().max(300),
  allowedTradingHoursUtc: z.array(TradingWindowSchema).max(32),
  permittedPhase7Actions: z.array(Phase7MandateActionSchema).min(3).max(6),
  expiresAt: z.string().datetime(),
  confirmation: z.literal("CREATE_IMMUTABLE_DEMO_MANDATE"),
}).strict();

const activationSchema = z.object({
  mandateId: z.number().int().positive(),
  reason: reasonSchema,
  confirmation: z.literal("ENABLE_DEMO_AUTOPILOT"),
}).strict();

const pauseSchema = z.object({ reason: reasonSchema }).strict();
const resumeSchema = z.object({
  reason: reasonSchema,
  confirmation: z.literal("RESUME_DEMO_AUTOPILOT"),
}).strict();
const revokeSchema = z.object({
  reason: reasonSchema,
  confirmation: z.literal("REVOKE_DEMO_AUTOPILOT_MANDATE"),
}).strict();

function badRequest(res: Response, error: unknown): void {
  const message = error instanceof Error ? error.message : "Request was refused";
  res.status(/not found/i.test(message) ? 404 : /not allowed|cannot|refused|expired|changed|mismatch/i.test(message) ? 409 : 400).json({ error: message });
}

router.get("/autopilot/control", async (req, res): Promise<void> => {
  await ensureBrainV0Version(req.userId!, req.section!);
  const [snapshot, versions, mandates, events] = await Promise.all([
    getAutopilotSnapshot(req.userId!, req.section!),
    listBrainVersions(req.userId!, req.section!),
    listMandates(req.userId!, req.section!),
    listAutopilotEvents(req.userId!, req.section!, 150),
  ]);
  res.json({
    globalSuspended: globalAutopilotSuspended(),
    snapshot,
    versions,
    mandates,
    events,
    authorityBoundary: ["simulated_demo", "binance_spot_testnet", "binance_futures_demo", "oanda_practice"],
    liveAuthorityEnabled: false,
  });
});

router.get("/autopilot/forward-soak", async (req, res): Promise<void> => {
  res.json(await buildForwardSoakReport(req.userId!, req.section!));
});

router.post("/autopilot/brain-versions", async (req, res): Promise<void> => {
  const parsed = registerVersionSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    const version = await registerBrainVersion({
      userId: req.userId!, section: req.section!, actorUserId: req.userId!,
      version: parsed.data.version,
      implementation: parsed.data.implementation,
      sourceCommit: parsed.data.sourceCommit,
      evidenceReferences: parsed.data.evidenceReferences,
    });
    res.status(201).json(version);
  } catch (error) { badRequest(res, error); }
});

router.post("/autopilot/brain-versions/:id/transition", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const parsed = transitionVersionSchema.safeParse(req.body);
  if (!Number.isInteger(id) || id <= 0 || !parsed.success) { res.status(400).json({ error: parsed.success ? "Invalid version id" : parsed.error.message }); return; }
  const expected = parsed.data.toState === "DEMO_APPROVED"
    ? "APPROVE_BRAIN_VERSION_FOR_DEMO"
    : parsed.data.toState === "SHADOW"
      ? "RETURN_BRAIN_VERSION_TO_SHADOW"
      : parsed.data.toState === "RETIRED"
        ? "RETIRE_BRAIN_VERSION"
        : `TRANSITION_BRAIN_VERSION_TO_${parsed.data.toState}`;
  if (parsed.data.confirmation !== expected) { res.status(400).json({ error: `confirmation must equal ${expected}` }); return; }
  try {
    const version = await transitionBrainVersion({
      userId: req.userId!, section: req.section!, versionId: id,
      toState: parsed.data.toState, reason: parsed.data.reason, actorUserId: req.userId!,
    });
    if (parsed.data.toState === "SHADOW" || parsed.data.toState === "SUSPENDED" || parsed.data.toState === "RETIRED") {
      const snapshot = await getAutopilotSnapshot(req.userId!, req.section!);
      if (snapshot.mandate?.brainVersionId === id) {
        await setAutopilotState({
          userId: req.userId!, section: req.section!, state: "AUTOPILOT_BLOCKED",
          reasonCode: `BRAIN_VERSION_${parsed.data.toState}`,
          reason: parsed.data.reason, actor: { actorType: "user", actorUserId: req.userId! },
          mandateId: snapshot.mandate.id, configSuspended: true,
        });
      }
    }
    res.json(version);
  } catch (error) { badRequest(res, error); }
});

router.post("/autopilot/mandates", async (req, res): Promise<void> => {
  const parsed = mandateSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    const engine = getOrCreateEngine(req.userId!, req.section!, { resumeIdleDemo: false });
    const config = await engine.loadConfig();
    if (config.mode !== "autopilot") throw new Error("Set this configuration to Autopilot mode before freezing its mandate");
    const authority = resolveExecutionAuthority({
      section: req.section!,
      marketType: config.marketType as "spot" | "futures" | "forex",
      executionTarget: config.executionTarget === "demo" ? "demo" : "live",
      testnet: config.testnet,
    });
    if (!DemoAutopilotAuthoritySchema.safeParse(authority).success) throw new Error("Autonomous Live authority is categorically disabled in Phase 10");
    const requestedInstruments = [...new Set(parsed.data.instruments.map((item) => item.trim()))].sort();
    const configuredInstruments = new Set(config.pairs.split(",").map((item) => item.trim()).filter(Boolean));
    if (requestedInstruments.some((item) => !configuredInstruments.has(item))) throw new Error("Every mandate instrument must be present in the exact bot configuration");
    const strategyConfigs = await loadStrategyConfigs(req.userId!, req.section!);
    const strategyVersions: Record<string, string> = {};
    for (const strategyId of [...new Set(parsed.data.strategyIds)].sort()) {
      const strategyConfig = strategyConfigs.get(strategyId);
      if (!strategyConfig?.enabled) throw new Error(`Strategy ${strategyId} is missing or disabled`);
      strategyVersions[strategyId] = strategyConfigVersion(strategyId, strategyConfig);
    }
    const maximumConfiguredLeverage = config.marketType === "futures" ? config.leverage : 1;
    // maximumPositionSizeUsdt caps PLAN NOTIONAL (what evaluateAutopilotEntry
    // compares), while bot_config.positionSizeUsdt is the pre-leverage trade
    // amount — plans are sized at amount × leverage (observed: $2,000 × 5× =
    // $10,000 notional, BUG-005). Bound the mandate against the largest
    // notional this deterministic configuration can produce so the mandate
    // can permit exactly the config's own trades and nothing more.
    const maximumConfiguredPositionNotionalUsdt =
      Number(config.positionSizeUsdt) * maximumConfiguredLeverage;
    const bounds: Array<[number, number, string]> = [
      [parsed.data.maximumPositionSizeUsdt, maximumConfiguredPositionNotionalUsdt, "maximumPositionSizeUsdt"],
      [parsed.data.maximumLeverage, maximumConfiguredLeverage, "maximumLeverage"],
      [parsed.data.maximumPortfolioRiskPercent, Number(config.maxPortfolioRiskPercent), "maximumPortfolioRiskPercent"],
      [parsed.data.maximumSymbolExposurePercent, Number(config.maxSymbolConcentrationPercent), "maximumSymbolExposurePercent"],
      [parsed.data.maximumNetExposurePercent, Number(config.maxNetExposurePercent), "maximumNetExposurePercent"],
      [parsed.data.maximumCorrelatedExposurePercent, Number(config.maxCorrelatedExposurePercent), "maximumCorrelatedExposurePercent"],
      [parsed.data.dailyLossLimitUsdt, Number(config.dailyLossLimitUsdt), "dailyLossLimitUsdt"],
      [parsed.data.maximumConcurrentPositions, config.maxOpenPositions, "maximumConcurrentPositions"],
    ];
    for (const [requested, configured, name] of bounds) {
      if (requested > configured) throw new Error(`${name} cannot expand the existing deterministic configuration limit (${configured})`);
    }
    const expiresAt = new Date(parsed.data.expiresAt);
    const now = new Date();
    if (expiresAt.getTime() <= now.getTime()) throw new Error("Mandate expiry must be in the future");
    if (expiresAt.getTime() > now.getTime() + 90 * 24 * 60 * 60 * 1000) throw new Error("Demo Autopilot mandates may not exceed 90 days");
    const versions = await listBrainVersions(req.userId!, req.section!);
    const brain = versions.find((item) => item.id === parsed.data.brainVersionId);
    if (!brain || brain.state !== "DEMO_APPROVED") throw new Error("The exact brain version is not DEMO_APPROVED");
    const mandate = await createMandate({
      schemaVersion: "phase10-demo-autopilot-v1",
      userId: req.userId!, section: req.section!,
      version: await nextMandateVersion(req.userId!, req.section!),
      botConfigId: config.id,
      configFingerprint: autopilotConfigFingerprint(config),
      brainVersionId: brain.id,
      brainVersion: brain.version,
      executionAuthority: authority as z.infer<typeof DemoAutopilotAuthoritySchema>,
      marketType: config.marketType as "spot" | "futures" | "forex",
      instruments: requestedInstruments,
      strategyVersions,
      maximumPositionSizeUsdt: parsed.data.maximumPositionSizeUsdt,
      maximumLeverage: parsed.data.maximumLeverage,
      maximumPortfolioRiskPercent: parsed.data.maximumPortfolioRiskPercent,
      maximumSymbolExposurePercent: parsed.data.maximumSymbolExposurePercent,
      maximumNetExposurePercent: parsed.data.maximumNetExposurePercent,
      maximumCorrelatedExposurePercent: parsed.data.maximumCorrelatedExposurePercent,
      dailyLossLimitUsdt: parsed.data.dailyLossLimitUsdt,
      maximumDrawdownPercent: parsed.data.maximumDrawdownPercent,
      maximumConcurrentPositions: parsed.data.maximumConcurrentPositions,
      maximumMarketDataAgeSeconds: parsed.data.maximumMarketDataAgeSeconds,
      allowedTradingHoursUtc: parsed.data.allowedTradingHoursUtc,
      permittedPhase7Actions: parsed.data.permittedPhase7Actions,
      validFrom: now.toISOString(), expiresAt: expiresAt.toISOString(),
    }, req.userId!);
    res.status(201).json(mandate);
  } catch (error) { badRequest(res, error); }
});

router.post("/autopilot/activate", async (req, res): Promise<void> => {
  const parsed = activationSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    if (globalAutopilotSuspended()) {
      await refuseAutopilotActivationWhileGloballySuspended({
        userId: req.userId!,
        section: req.section!,
        requestedMandateId: parsed.data.mandateId,
        actorUserId: req.userId!,
      });
      throw new Error("Global Demo Autopilot suspension is active; activation is refused");
    }
    const config = await getOrCreateEngine(req.userId!, req.section!, { resumeIdleDemo: false }).loadConfig();
    const mandate = (await listMandates(req.userId!, req.section!)).find((item) => item.id === parsed.data.mandateId);
    if (!mandate) throw new Error("Mandate not found");
    if (config.mode !== "autopilot" || autopilotConfigFingerprint(config) !== mandate.configFingerprint) throw new Error("Configuration changed or is not in Autopilot mode; create a new immutable mandate");
    const authority = resolveExecutionAuthority({ section: req.section!, marketType: config.marketType as "spot" | "futures" | "forex", executionTarget: config.executionTarget === "demo" ? "demo" : "live", testnet: config.testnet });
    if (authority !== mandate.executionAuthority || !DemoAutopilotAuthoritySchema.safeParse(authority).success) throw new Error("Execution authority does not match the approved Demo/testnet/practice mandate");
    const control = await setAutopilotState({
      userId: req.userId!, section: req.section!, state: "AUTOPILOT_ENABLED",
      reasonCode: "HUMAN_ACTIVATION_APPROVED", reason: parsed.data.reason,
      actor: { actorType: "user", actorUserId: req.userId! }, mandateId: mandate.id,
      configSuspended: false, globalSuspended: globalAutopilotSuspended(),
    });
    res.json(control);
  } catch (error) { badRequest(res, error); }
});

router.post("/autopilot/pause", async (req, res): Promise<void> => {
  const parsed = pauseSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    const snapshot = await getAutopilotSnapshot(req.userId!, req.section!);
    const control = await setAutopilotState({
      userId: req.userId!, section: req.section!, state: "AUTOPILOT_PAUSED",
      reasonCode: "HUMAN_PAUSE", reason: parsed.data.reason,
      actor: { actorType: "user", actorUserId: req.userId! }, mandateId: snapshot.mandate?.id ?? null,
      configSuspended: true,
    });
    res.json(control);
  } catch (error) { badRequest(res, error); }
});

router.post("/autopilot/resume", async (req, res): Promise<void> => {
  const parsed = resumeSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    const snapshot = await getAutopilotSnapshot(req.userId!, req.section!);
    if (!snapshot.mandate) throw new Error("No mandate is available to resume");
    if (globalAutopilotSuspended()) throw new Error("Global Demo Autopilot suspension is active; resume is refused");
    const config = await getOrCreateEngine(req.userId!, req.section!, { resumeIdleDemo: false }).loadConfig();
    if (autopilotConfigFingerprint(config) !== snapshot.mandate.configFingerprint) throw new Error("Configuration changed; a new mandate is required");
    const control = await setAutopilotState({
      userId: req.userId!, section: req.section!, state: "AUTOPILOT_ENABLED",
      reasonCode: "HUMAN_RESUME_APPROVED", reason: parsed.data.reason,
      actor: { actorType: "user", actorUserId: req.userId! }, mandateId: snapshot.mandate.id,
      configSuspended: false, globalSuspended: globalAutopilotSuspended(),
    });
    res.json(control);
  } catch (error) { badRequest(res, error); }
});

router.post("/autopilot/mandates/:id/revoke", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const parsed = revokeSchema.safeParse(req.body);
  if (!Number.isInteger(id) || id <= 0 || !parsed.success) { res.status(400).json({ error: parsed.success ? "Invalid mandate id" : parsed.error.message }); return; }
  try {
    await revokeMandate({ userId: req.userId!, section: req.section!, mandateId: id, actorUserId: req.userId!, reason: parsed.data.reason });
    res.json(await getAutopilotSnapshot(req.userId!, req.section!));
  } catch (error) { badRequest(res, error); }
});

export default router;
