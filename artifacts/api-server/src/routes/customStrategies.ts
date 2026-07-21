/**
 * Custom strategy CRUD — the no-code strategy builder API.
 *
 * GET    /custom-strategies      — list this user's custom strategies (section-scoped)
 * POST   /custom-strategies      — create (rules zod-validated; id becomes custom_<dbId>)
 * PUT    /custom-strategies/:id  — update name/description/rules (rules edit RESETS the
 *                                  backtest-first gate — a changed strategy is untested)
 * DELETE /custom-strategies/:id  — delete (also removes its strategy_configs row)
 *
 * Demo accounts: demoGuard already 403s every non-GET before this router runs.
 * Risk/exit tuning lives on the shared strategy_configs row (PUT /strategies/:id),
 * which is also where the live-enable gate is enforced.
 */
import { Router } from "express";
import { db } from "@workspace/db";
import { customStrategiesTable, strategyConfigsTable, type CustomStrategyRow } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { CustomRulesSchema, describeRules, parseCustomRules, MAX_CUSTOM_STRATEGIES } from "../lib/customRules";
import { DEFAULT_CUSTOM_STRATEGY_CONFIG } from "../lib/strategies/custom";
import { invalidateCustomStrategies } from "../lib/customStrategyLoader";
import { logger } from "../lib/logger";

const router = Router();

const NameSchema = z.string().trim().min(1).max(60);
const DescriptionSchema = z.string().trim().max(500);

function serialize(row: CustomStrategyRow) {
  let indicators: string[] = [];
  let rulesValid = true;
  try {
    indicators = describeRules(parseCustomRules(row.rules));
  } catch {
    rulesValid = false; // out-of-band corruption; the engine loader skips it too
  }
  return {
    id: row.id,
    strategyId: row.strategyId,
    section: row.section,
    name: row.name,
    description: row.description,
    rules: row.rules,
    indicators,
    rulesValid,
    backtested: row.lastBacktestAt != null,
    lastBacktestAt: row.lastBacktestAt ? row.lastBacktestAt.toISOString() : null,
    rulesUpdatedAt: row.rulesUpdatedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function zodMessage(err: z.ZodError): string[] {
  return err.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message));
}

// ---------------------------------------------------------------------------
// GET /custom-strategies
// ---------------------------------------------------------------------------

router.get("/custom-strategies", async (req, res) => {
  try {
    const rows = await db
      .select()
      .from(customStrategiesTable)
      .where(and(eq(customStrategiesTable.userId, req.userId!), eq(customStrategiesTable.section, req.section!)))
      .orderBy(customStrategiesTable.id);
    res.json(rows.map(serialize));
  } catch (err) {
    logger.error({ err }, "GET /custom-strategies failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /custom-strategies
// ---------------------------------------------------------------------------

router.post("/custom-strategies", async (req, res) => {
  const b = req.body as Record<string, unknown>;

  const name = NameSchema.safeParse(b.name);
  if (!name.success) {
    return res.status(400).json({ error: "Invalid name", details: zodMessage(name.error) });
  }
  const description = b.description == null ? null : DescriptionSchema.safeParse(b.description);
  if (description && !description.success) {
    return res.status(400).json({ error: "Invalid description", details: zodMessage(description.error) });
  }
  const rules = CustomRulesSchema.safeParse(b.rules);
  if (!rules.success) {
    return res.status(400).json({ error: "Invalid rules", details: zodMessage(rules.error) });
  }

  try {
    const [{ count }] = (await db
      .select({ count: sql<number>`count(*)::int` })
      .from(customStrategiesTable)
      .where(and(eq(customStrategiesTable.userId, req.userId!), eq(customStrategiesTable.section, req.section!)))) as [{ count: number }];
    if (count >= MAX_CUSTOM_STRATEGIES) {
      return res.status(400).json({
        error: `Limit reached: up to ${MAX_CUSTOM_STRATEGIES} custom strategies per section. Delete one to make room.`,
      });
    }

    const [inserted] = await db
      .insert(customStrategiesTable)
      .values({
        userId: req.userId!,
        section: req.section!,
        name: name.data,
        description: description ? description.data : null,
        rules: rules.data as object,
      })
      .returning();

    // Engine-facing id derives from the DB id — collision-proof against
    // built-ins and other users, and stable for the strategy's lifetime.
    const strategyId = `custom_${inserted!.id}`;
    const [row] = await db
      .update(customStrategiesTable)
      .set({ strategyId })
      .where(eq(customStrategiesTable.id, inserted!.id))
      .returning();

    // Seed its risk/exit config row DISABLED with no dollar plan — the user
    // must consciously set a trade plan and enable it (post-backtest) before
    // it can ever trade. Same table/shape as every built-in.
    const d = DEFAULT_CUSTOM_STRATEGY_CONFIG;
    await db
      .insert(strategyConfigsTable)
      .values({
        userId: req.userId!,
        section: req.section!,
        strategyId,
        strategyName: name.data,
        enabled: d.enabled,
        tradeAmountUsdt: null, maxLossUsdt: null, targetProfitUsdt: null,
        riskPercent: String(d.riskPercent),
        confidenceThreshold: d.confidenceThreshold,
        stopLossPercent: String(d.stopLossPercent),
        takeProfitPercent: String(d.takeProfitPercent),
        maxHoldingSeconds: d.maxHoldingSeconds,
        maxConcurrentPositions: d.maxConcurrentPositions,
        cooldownMinutes: d.cooldownMinutes,
        breakEvenRMultiple: String(d.breakEvenRMultiple),
        tp1RMultiple: String(d.tp1RMultiple),
        tp1ClosePercent: d.tp1ClosePercent,
        tp3Enabled: d.tp3Enabled,
        tp2RMultiple: String(d.tp2RMultiple),
        tp2ClosePercent: d.tp2ClosePercent,
        tp3RMultiple: String(d.tp3RMultiple),
        trailingStopMode: d.trailingStopMode,
        trailingStopAtrMultiplier: String(d.trailingStopAtrMultiplier),
        trailingStopPercent: String(d.trailingStopPercent),
        trailingAfterTp1Only: d.trailingAfterTp1Only,
        emergencyTrailingRMultiple: String(d.emergencyTrailingRMultiple),
        emergencyTrailingPercent: String(d.emergencyTrailingPercent),
        exitPriority: d.exitPriority.join(","),
      })
      .onConflictDoNothing({
        target: [strategyConfigsTable.userId, strategyConfigsTable.section, strategyConfigsTable.strategyId],
      });

    invalidateCustomStrategies(req.userId!, req.section!);
    return res.status(201).json(serialize(row!));
  } catch (err) {
    logger.error({ err }, "POST /custom-strategies failed");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// PUT /custom-strategies/:id
// ---------------------------------------------------------------------------

router.put("/custom-strategies/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Invalid id" });
  }
  const b = req.body as Record<string, unknown>;

  const updates: Partial<typeof customStrategiesTable.$inferInsert> = {};
  if (b.name !== undefined) {
    const name = NameSchema.safeParse(b.name);
    if (!name.success) return res.status(400).json({ error: "Invalid name", details: zodMessage(name.error) });
    updates.name = name.data;
  }
  if (b.description !== undefined) {
    if (b.description === null) updates.description = null;
    else {
      const description = DescriptionSchema.safeParse(b.description);
      if (!description.success) return res.status(400).json({ error: "Invalid description", details: zodMessage(description.error) });
      updates.description = description.data;
    }
  }
  if (b.rules !== undefined) {
    const rules = CustomRulesSchema.safeParse(b.rules);
    if (!rules.success) return res.status(400).json({ error: "Invalid rules", details: zodMessage(rules.error) });
    updates.rules = rules.data as object;
    // A changed rule set is a NEW, untested strategy — the backtest-first
    // gate re-arms and the live engine drops it until it's re-backtested.
    updates.lastBacktestAt = null;
    updates.rulesUpdatedAt = new Date();
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "Nothing to update — send name, description and/or rules" });
  }

  try {
    const [row] = await db
      .update(customStrategiesTable)
      .set(updates)
      .where(and(
        eq(customStrategiesTable.id, id),
        eq(customStrategiesTable.userId, req.userId!),
        eq(customStrategiesTable.section, req.section!),
      ))
      .returning();
    if (!row) return res.status(404).json({ error: "Custom strategy not found" });

    // Keep the config row's display name in sync.
    if (updates.name) {
      await db
        .update(strategyConfigsTable)
        .set({ strategyName: updates.name })
        .where(and(
          eq(strategyConfigsTable.userId, req.userId!),
          eq(strategyConfigsTable.section, req.section!),
          eq(strategyConfigsTable.strategyId, row.strategyId),
        ));
    }

    invalidateCustomStrategies(req.userId!, req.section!);
    return res.json(serialize(row));
  } catch (err) {
    logger.error({ err, id }, "PUT /custom-strategies/:id failed");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// DELETE /custom-strategies/:id
// ---------------------------------------------------------------------------

router.delete("/custom-strategies/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Invalid id" });
  }
  try {
    const [row] = await db
      .delete(customStrategiesTable)
      .where(and(
        eq(customStrategiesTable.id, id),
        eq(customStrategiesTable.userId, req.userId!),
        eq(customStrategiesTable.section, req.section!),
      ))
      .returning();
    if (!row) return res.status(404).json({ error: "Custom strategy not found" });

    // Its risk/exit config goes with it — a dangling row would resurrect the
    // id in loadStrategyConfigs' custom union forever.
    await db
      .delete(strategyConfigsTable)
      .where(and(
        eq(strategyConfigsTable.userId, req.userId!),
        eq(strategyConfigsTable.section, req.section!),
        eq(strategyConfigsTable.strategyId, row.strategyId),
      ));

    invalidateCustomStrategies(req.userId!, req.section!);
    return res.json({ success: true, strategyId: row.strategyId });
  } catch (err) {
    logger.error({ err, id }, "DELETE /custom-strategies/:id failed");
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
