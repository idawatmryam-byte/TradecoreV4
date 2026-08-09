import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { botConfigTable, tradesTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { getOrCreateEngine } from "../lib/engineRegistry";
import { forexDemoAvailable } from "../lib/execution/demoMarketData";
import { getBinanceCredentials } from "../lib/binanceCredentials";
import { getOandaCredentials } from "../lib/oandaCredentials";
import {
  actionableConnectionError,
  testBinanceConnection,
  testOandaConnection,
} from "../lib/brokers/connectionTest";
import {
  GetConfigResponse,
  GetSectionsResponse,
  UpdateConfigBody,
  UpdateConfigResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

// SSRF guard: botEngine.sendAlert() fetches this URL server-side on every
// risk alert, so an authenticated caller could otherwise point it at
// internal-only services (e.g. cloud instance metadata at 169.254.169.254).
// Only blocks obvious literal loopback/private/link-local hosts — it does
// NOT protect against DNS rebinding (a public hostname resolving to a
// private IP at fetch time), which would need resolving+checking the IP at
// request time in botEngine itself.
const PRIVATE_HOSTNAME_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^0\.0\.0\.0$/,
  /^::1$/,
  /^169\.254\./, // link-local, includes the AWS/GCP/Azure metadata IP
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
];

function isSafeAlertWebhookUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const hostname = url.hostname.toLowerCase();
  return !PRIVATE_HOSTNAME_PATTERNS.some((re) => re.test(hostname));
}

/**
 * Can this section actually RUN in demo on this deployment?
 *
 * Crypto always can — Binance's public endpoints need no credentials. Forex
 * cannot unless the platform supplies its own OANDA practice token, because
 * OANDA publishes no public market data at all. Reported per section so the
 * UI can stop promising a keyless demo it is about to fail to deliver: without
 * this the dashboard told a new forex user "no broker needed", they pressed
 * START, and the engine refused with nothing on screen to explain why.
 */
function demoDataAvailableFor(section: string): boolean {
  return section === "forex" ? forexDemoAvailable() : true;
}

function mapConfig(c: typeof botConfigTable.$inferSelect) {
  return {
    demoDataAvailable: demoDataAvailableFor(c.section),
    broker:                    c.broker as "binance" | "oanda",
    marketType:                c.marketType as "spot" | "futures" | "forex",
    leverage:                  c.leverage,
    marginMode:                c.marginMode as "isolated" | "cross",
    positionSizeUsdt:          Number(c.positionSizeUsdt),
    riskPercent:               Number(c.riskPercent),
    maxOpenPositions:          c.maxOpenPositions,
    maxPortfolioRiskPercent:   Number(c.maxPortfolioRiskPercent),
    dailyLossLimitUsdt:        Number(c.dailyLossLimitUsdt),
    maxSymbolConcentrationPercent: Number(c.maxSymbolConcentrationPercent),
    maxNetExposurePercent:     Number(c.maxNetExposurePercent),
    maxCorrelatedExposurePercent: Number(c.maxCorrelatedExposurePercent),
    correlationThreshold:      Number(c.correlationThreshold),
    correlationUnknownPolicy:  c.correlationUnknownPolicy as "allow" | "block",
    confidenceThreshold:       c.confidenceThreshold,
    riskModel:                 c.riskModel as "percent" | "dollar",
    stopLossPercent:           Number(c.stopLossPercent),
    takeProfitPercent:         Number(c.takeProfitPercent),
    maxLossUsdt:               Number(c.maxLossUsdt),
    targetProfitUsdt:          Number(c.targetProfitUsdt),
    cooldownMinutes:           c.cooldownMinutes,
    scanIntervalSeconds:       c.scanIntervalSeconds,
    pairs:                     c.pairs.split(",").map((p: string) => p.trim()).filter(Boolean),
    executionTarget:           c.executionTarget as "demo" | "live",
    mode:                      c.mode as "research" | "copilot" | "autopilot",
    positionManagementMode:    c.positionManagementMode as "fixed" | "phase7_shadow" | "phase7_active",
    demoStartingBalanceUsdt:   Number(c.demoStartingBalanceUsdt),
    testnet:                   c.testnet,
    backtestMode:              c.backtestMode,
    highFrequencyTestMode:     c.highFrequencyTestMode,
    alertWebhookUrl:           c.alertWebhookUrl ?? null,
  };
}

/**
 * Which sections has this user actually set up?
 *
 * Deliberately reads the table directly instead of going through
 * `getOrCreateEngine` — that helper creates the row it fails to find, which
 * would make this endpoint manufacture the very thing it is reporting on.
 * Not section-scoped: it is a question about the sections, not within one.
 */
router.get("/sections", async (req, res): Promise<void> => {
  const rows = await db
    .select({ section: botConfigTable.section, activated: botConfigTable.activated })
    .from(botConfigTable)
    .where(eq(botConfigTable.userId, req.userId!));

  res.json(GetSectionsResponse.parse({
    activated: rows.filter((r) => r.activated).map((r) => r.section),
  }));
});

router.get("/config", async (req, res): Promise<void> => {
  const config = await getOrCreateEngine(req.userId!, req.section!).loadConfig();
  res.json(GetConfigResponse.parse(mapConfig(config)));
});

router.put("/config", async (req, res): Promise<void> => {
  const parsed = UpdateConfigBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  if (parsed.data.alertWebhookUrl && !isSafeAlertWebhookUrl(parsed.data.alertWebhookUrl)) {
    res.status(400).json({ error: "alertWebhookUrl must be a public http(s) URL (not localhost/private/link-local)" });
    return;
  }

  const engine = getOrCreateEngine(req.userId!, req.section!, { resumeIdleDemo: false });
  const existing = await engine.loadConfig();
  const u = parsed.data;
  const nextExecutionTarget = u.executionTarget ?? existing.executionTarget;
  const nextMarketType = u.marketType ?? existing.marketType;
  const nextTestnet = u.testnet ?? existing.testnet;
  const nextPositionManagementMode = u.positionManagementMode ?? existing.positionManagementMode;
  const connectionChanged =
    nextExecutionTarget !== existing.executionTarget ||
    nextMarketType !== existing.marketType ||
    nextTestnet !== existing.testnet;

  if (nextPositionManagementMode === "phase7_active" && nextExecutionTarget === "live" && !nextTestnet) {
    res.status(400).json({
      error: "Phase 7 active management is not promoted for real Live. Select fixed or Shadow management, or use Demo/Binance testnet/OANDA practice.",
      code: "PHASE7_LIVE_AUTHORITY_DISABLED",
    });
    return;
  }

  if (connectionChanged) {
    const [openTrade] = await db
      .select({ id: tradesTable.id })
      .from(tradesTable)
      .where(and(
        eq(tradesTable.userId, req.userId!),
        eq(tradesTable.section, req.section!),
        eq(tradesTable.status, "open"),
      ))
      .limit(1);
    if (openTrade) {
      res.status(409).json({
        error: "Close every open position in this section before changing Demo/Live, market type, or broker environment. The active engine connection must continue managing the positions it opened.",
        code: "OPEN_POSITIONS_BLOCK_CONNECTION_CHANGE",
      });
      return;
    }
  }

  if (connectionChanged && nextExecutionTarget === "demo" && !demoDataAvailableFor(existing.section)) {
    res.status(400).json({
      error: "Forex Demo is unavailable on this deployment because OANDA has no public market-data API. Configure the platform OANDA practice account before switching this section to Demo.",
      code: "DEMO_DATA_UNAVAILABLE",
    });
    return;
  }

  // A transition onto a broker endpoint is validated BEFORE persistence, so
  // the database cannot claim Live while the selected credentials belong to
  // another environment or lack the required product permission.
  if (connectionChanged && nextExecutionTarget === "live") {
    try {
      if (existing.section === "forex") {
        const credentials = await getOandaCredentials(req.userId!);
        if (!credentials) {
          res.status(400).json({ error: "Connect and test an OANDA account before enabling Live trading.", code: "CREDENTIALS_MISSING" });
          return;
        }
        await testOandaConnection({ ...credentials, practice: nextTestnet });
      } else {
        const credentials = await getBinanceCredentials(req.userId!);
        if (!credentials) {
          res.status(400).json({ error: "Connect and test Binance credentials before enabling Live trading.", code: "CREDENTIALS_MISSING" });
          return;
        }
        await testBinanceConnection({
          ...credentials,
          marketType: nextMarketType === "futures" ? "futures" : "spot",
          testnet: nextTestnet,
        });
      }
    } catch (err) {
      const provider = existing.section === "forex" ? "oanda" : "binance";
      const mapped = actionableConnectionError(provider, err);
      req.log.warn({ userId: req.userId, section: existing.section, code: mapped.code }, "Live config transition refused by connection validation");
      res.status(400).json({ error: mapped.message, code: mapped.code });
      return;
    }
  }

  const [updated] = await db
    .update(botConfigTable)
    .set({
      // Writing a section's configuration IS setting it up — this is the
      // definition of the flag, not a side effect. It is what promotes a
      // section from "offered" to "yours" in the navigation, and why merely
      // opening the Add Market flow (a read) leaves nothing behind.
      activated: true,
      ...(u.marketType                !== undefined && { marketType:                 u.marketType }),
      ...(u.leverage                  !== undefined && { leverage:                   u.leverage }),
      ...(u.marginMode                !== undefined && { marginMode:                 u.marginMode }),
      ...(u.positionSizeUsdt          !== undefined && { positionSizeUsdt:          String(u.positionSizeUsdt) }),
      ...(u.riskPercent               !== undefined && { riskPercent:               String(u.riskPercent) }),
      ...(u.maxOpenPositions          !== undefined && { maxOpenPositions:           u.maxOpenPositions }),
      ...(u.maxPortfolioRiskPercent   !== undefined && { maxPortfolioRiskPercent:    String(u.maxPortfolioRiskPercent) }),
      ...(u.dailyLossLimitUsdt        !== undefined && { dailyLossLimitUsdt:         String(u.dailyLossLimitUsdt) }),
      ...(u.maxSymbolConcentrationPercent !== undefined && { maxSymbolConcentrationPercent: String(u.maxSymbolConcentrationPercent) }),
      ...(u.maxNetExposurePercent     !== undefined && { maxNetExposurePercent:      String(u.maxNetExposurePercent) }),
      ...(u.maxCorrelatedExposurePercent !== undefined && { maxCorrelatedExposurePercent: String(u.maxCorrelatedExposurePercent) }),
      ...(u.correlationThreshold      !== undefined && { correlationThreshold:       String(u.correlationThreshold) }),
      ...(u.correlationUnknownPolicy  !== undefined && { correlationUnknownPolicy:   u.correlationUnknownPolicy }),
      ...(u.confidenceThreshold       !== undefined && { confidenceThreshold:        u.confidenceThreshold }),
      ...(u.riskModel                 !== undefined && { riskModel:                  u.riskModel }),
      ...(u.stopLossPercent           !== undefined && { stopLossPercent:            String(u.stopLossPercent) }),
      ...(u.takeProfitPercent         !== undefined && { takeProfitPercent:          String(u.takeProfitPercent) }),
      ...(u.maxLossUsdt               !== undefined && { maxLossUsdt:                String(u.maxLossUsdt) }),
      ...(u.targetProfitUsdt          !== undefined && { targetProfitUsdt:           String(u.targetProfitUsdt) }),
      ...(u.cooldownMinutes           !== undefined && { cooldownMinutes:            u.cooldownMinutes }),
      ...(u.scanIntervalSeconds       !== undefined && { scanIntervalSeconds:        u.scanIntervalSeconds }),
      ...(u.pairs                     !== undefined && { pairs:                      u.pairs.join(",") }),
      ...(u.executionTarget           !== undefined && { executionTarget:            u.executionTarget }),
      ...(u.mode                      !== undefined && { mode:                       u.mode }),
      ...(u.positionManagementMode    !== undefined && { positionManagementMode:     u.positionManagementMode }),
      ...(u.demoStartingBalanceUsdt   !== undefined && { demoStartingBalanceUsdt:    String(u.demoStartingBalanceUsdt) }),
      ...(u.testnet                   !== undefined && { testnet:                    u.testnet }),
      ...(u.backtestMode              !== undefined && { backtestMode:               u.backtestMode }),
      ...(u.highFrequencyTestMode     !== undefined && { highFrequencyTestMode:      u.highFrequencyTestMode }),
      ...(u.alertWebhookUrl           !== undefined && { alertWebhookUrl:            u.alertWebhookUrl ?? null }),
    })
    .where(eq(botConfigTable.id, existing.id))
    .returning();

  req.log.info({ configId: existing.id }, "Config updated");
  if (connectionChanged) {
    try {
      await engine.refreshConnection({
        restartIfDesired: true,
        reason: "Execution target/environment changed — reconnecting from persisted configuration",
      });
    } catch (err) {
      const provider = existing.section === "forex" ? "oanda" : "binance";
      const mapped = actionableConnectionError(provider, err);
      req.log.error({ userId: req.userId, section: existing.section, code: mapped.code }, "Config saved but engine reconnect failed");
      res.status(409).json({
        error: `Configuration was saved, but the engine was stopped because reconnection failed. ${mapped.message}`,
        code: mapped.code,
      });
      return;
    }
  }
  res.json(UpdateConfigResponse.parse(mapConfig(updated ?? existing)));
});

export default router;
