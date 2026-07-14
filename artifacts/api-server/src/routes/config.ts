import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { botConfigTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getOrCreateEngine } from "../lib/engineRegistry";
import {
  GetConfigResponse,
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

function mapConfig(c: typeof botConfigTable.$inferSelect) {
  return {
    marketType:                c.marketType as "spot" | "futures",
    leverage:                  c.leverage,
    marginMode:                c.marginMode as "isolated" | "cross",
    positionSizeUsdt:          Number(c.positionSizeUsdt),
    riskPercent:               Number(c.riskPercent),
    maxOpenPositions:          c.maxOpenPositions,
    maxPortfolioRiskPercent:   Number(c.maxPortfolioRiskPercent),
    dailyLossLimitUsdt:        Number(c.dailyLossLimitUsdt),
    confidenceThreshold:       c.confidenceThreshold,
    riskModel:                 c.riskModel as "percent" | "dollar",
    stopLossPercent:           Number(c.stopLossPercent),
    takeProfitPercent:         Number(c.takeProfitPercent),
    maxLossUsdt:               Number(c.maxLossUsdt),
    targetProfitUsdt:          Number(c.targetProfitUsdt),
    cooldownMinutes:           c.cooldownMinutes,
    scanIntervalSeconds:       c.scanIntervalSeconds,
    pairs:                     c.pairs.split(",").map((p: string) => p.trim()).filter(Boolean),
    testnet:                   c.testnet,
    backtestMode:              c.backtestMode,
    highFrequencyTestMode:     c.highFrequencyTestMode,
    alertWebhookUrl:           c.alertWebhookUrl ?? null,
  };
}

router.get("/config", async (req, res): Promise<void> => {
  const config = await getOrCreateEngine(req.userId!).loadConfig();
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

  const existing = await getOrCreateEngine(req.userId!).loadConfig();
  const u = parsed.data;

  const [updated] = await db
    .update(botConfigTable)
    .set({
      ...(u.marketType                !== undefined && { marketType:                 u.marketType }),
      ...(u.leverage                  !== undefined && { leverage:                   u.leverage }),
      ...(u.marginMode                !== undefined && { marginMode:                 u.marginMode }),
      ...(u.positionSizeUsdt          !== undefined && { positionSizeUsdt:          String(u.positionSizeUsdt) }),
      ...(u.riskPercent               !== undefined && { riskPercent:               String(u.riskPercent) }),
      ...(u.maxOpenPositions          !== undefined && { maxOpenPositions:           u.maxOpenPositions }),
      ...(u.maxPortfolioRiskPercent   !== undefined && { maxPortfolioRiskPercent:    String(u.maxPortfolioRiskPercent) }),
      ...(u.dailyLossLimitUsdt        !== undefined && { dailyLossLimitUsdt:         String(u.dailyLossLimitUsdt) }),
      ...(u.confidenceThreshold       !== undefined && { confidenceThreshold:        u.confidenceThreshold }),
      ...(u.riskModel                 !== undefined && { riskModel:                  u.riskModel }),
      ...(u.stopLossPercent           !== undefined && { stopLossPercent:            String(u.stopLossPercent) }),
      ...(u.takeProfitPercent         !== undefined && { takeProfitPercent:          String(u.takeProfitPercent) }),
      ...(u.maxLossUsdt               !== undefined && { maxLossUsdt:                String(u.maxLossUsdt) }),
      ...(u.targetProfitUsdt          !== undefined && { targetProfitUsdt:           String(u.targetProfitUsdt) }),
      ...(u.cooldownMinutes           !== undefined && { cooldownMinutes:            u.cooldownMinutes }),
      ...(u.scanIntervalSeconds       !== undefined && { scanIntervalSeconds:        u.scanIntervalSeconds }),
      ...(u.pairs                     !== undefined && { pairs:                      u.pairs.join(",") }),
      ...(u.testnet                   !== undefined && { testnet:                    u.testnet }),
      ...(u.backtestMode              !== undefined && { backtestMode:               u.backtestMode }),
      ...(u.highFrequencyTestMode     !== undefined && { highFrequencyTestMode:      u.highFrequencyTestMode }),
      ...(u.alertWebhookUrl           !== undefined && { alertWebhookUrl:            u.alertWebhookUrl ?? null }),
    })
    .where(eq(botConfigTable.id, existing.id))
    .returning();

  req.log.info({ configId: existing.id }, "Config updated");
  res.json(UpdateConfigResponse.parse(mapConfig(updated ?? existing)));
});

export default router;
