/**
 * Daily trade report — on-demand counterpart of the UTC-midnight webhook
 * push (see botEngine's rollover hook). Same builder, same numbers.
 */
import { Router, type IRouter } from "express";
import { buildDailyReport } from "../lib/dailyReport";
import { GetDailyReportResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/reports/daily", async (req, res): Promise<void> => {
  const raw = typeof req.query.date === "string" ? req.query.date : undefined;
  const date = raw ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(`${date}T00:00:00Z`).getTime())) {
    res.status(400).json({ error: "date must be YYYY-MM-DD" });
    return;
  }

  const report = await buildDailyReport(req.userId!, date, req.section!);
  res.json(GetDailyReportResponse.parse(report));
});

export default router;
