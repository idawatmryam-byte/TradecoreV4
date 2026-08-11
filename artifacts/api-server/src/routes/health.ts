import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { HealthCheckResponse } from "@workspace/api-zod";
import { logger } from "../lib/logger";
import { getEngineResumeHealth } from "../lib/startupHealth";
import { readinessState } from "../lib/readiness";

const router: IRouter = Router();

// Liveness: is the process up and serving? Cheap, dependency-free — used by
// load balancers / uptime monitors to decide "is it running at all".
router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

// Readiness: is the process able to do real work RIGHT NOW — specifically, can
// it reach its database? Distinct from liveness: a process can be alive but
// unready (DB down/unreachable), and routing traffic to it would just produce
// 500s. Returns 200 {ready:true} when the DB answers, 503 {ready:false} with
// the reason otherwise. Unauthenticated, like /healthz.
router.get("/readyz", async (_req, res) => {
  try {
    await db.execute(sql`select 1`);
    const engineResume = getEngineResumeHealth();
    const readiness = readinessState(true, engineResume);
    if (!readiness.ready) {
      res.status(503).json({ ...readiness, checks: { database: "ok", engineResume } });
      return;
    }
    res.json({ ...readiness, checks: { database: "ok", engineResume } });
  } catch (err) {
    logger.error({ err }, "READINESS_CHECK_FAILED");
    const readiness = readinessState(false, getEngineResumeHealth());
    res.status(503).json({ ...readiness, checks: { database: "unreachable" } });
  }
});

export default router;
