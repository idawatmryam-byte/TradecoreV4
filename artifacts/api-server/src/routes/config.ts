import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { botConfigTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { botEngine } from "../lib/botEngine";
import {
  GetConfigResponse,
  UpdateConfigBody,
  UpdateConfigResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

function mapConfig(c: typeof botConfigTable.$inferSelect) {
  return {
    positionSizeUsdt:          Number(c.positionSizeUsdt),
    riskPercent:               Number(c.riskPercent),
    maxOpenPositions:          c.maxOpenPositions,
    maxPortfolioRiskPercent:   Number(c.maxPortfolioRiskPercent),
    dailyLossLimitUsdt:        Number(c.dailyLossLimitUsdt),
    confidenceThreshold:       c.confidenceThreshold,
    stopLossPercent:           Number(c.stopLossPercent),
    takeProfitPercent:         Number(c.takeProfitPercent),
    cooldownMinutes:           c.cooldownMinutes,
    scanIntervalSeconds:       c.scanIntervalSeconds,
    pairs:                     c.pairs.split(",").map((p: string) => p.trim()).filter(Boolean),
    testnet:                   c.testnet,
    backtestMode:              c.backtestMode,
    alertWebhookUrl:           c.alertWebhookUrl ?? null,
  };
}

router.get("/config", async (_req, res): Promise<void> => {
  const config = await botEngine.loadConfig();
  res.json(GetConfigResponse.parse(mapConfig(config)));
});

router.put("/config", async (req, res): Promise<void> => {
  const parsed = UpdateConfigBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const existing = await botEngine.loadConfig();
  const u = parsed.data;

  const [updated] = await db
    .update(botConfigTable)
    .set({
      ...(u.positionSizeUsdt          !== undefined && { positionSizeUsdt:          String(u.positionSizeUsdt) }),
      ...(u.riskPercent               !== undefined && { riskPercent:               String(u.riskPercent) }),
      ...(u.maxOpenPositions          !== undefined && { maxOpenPositions:           u.maxOpenPositions }),
      ...(u.maxPortfolioRiskPercent   !== undefined && { maxPortfolioRiskPercent:    String(u.maxPortfolioRiskPercent) }),
      ...(u.dailyLossLimitUsdt        !== undefined && { dailyLossLimitUsdt:         String(u.dailyLossLimitUsdt) }),
      ...(u.confidenceThreshold       !== undefined && { confidenceThreshold:        u.confidenceThreshold }),
      ...(u.stopLossPercent           !== undefined && { stopLossPercent:            String(u.stopLossPercent) }),
      ...(u.takeProfitPercent         !== undefined && { takeProfitPercent:          String(u.takeProfitPercent) }),
      ...(u.cooldownMinutes           !== undefined && { cooldownMinutes:            u.cooldownMinutes }),
      ...(u.scanIntervalSeconds       !== undefined && { scanIntervalSeconds:        u.scanIntervalSeconds }),
      ...(u.pairs                     !== undefined && { pairs:                      u.pairs.join(",") }),
      ...(u.testnet                   !== undefined && { testnet:                    u.testnet }),
      ...(u.backtestMode              !== undefined && { backtestMode:               u.backtestMode }),
      ...(u.alertWebhookUrl           !== undefined && { alertWebhookUrl:            u.alertWebhookUrl ?? null }),
    })
    .where(eq(botConfigTable.id, existing.id))
    .returning();

  req.log.info({ configId: existing.id }, "Config updated");
  res.json(UpdateConfigResponse.parse(mapConfig(updated ?? existing)));
});

export default router;
