import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import botRouter from "./bot";
import scannerRouter from "./scanner";
import marketRouter from "./market";
import tradesRouter from "./trades";
import statsRouter from "./stats";
import memoryRouter from "./memory";
import configRouter from "./config";
import backtestsRouter from "./backtests";
import autopsyRouter from "./autopsy";
import strategiesRouter from "./strategies";
import customStrategiesRouter from "./customStrategies";
import credentialsRouter from "./credentials";
import reportsRouter from "./reports";
import accountRouter from "./account";
import decisionsRouter from "./decisions";

// Deliberately NOT behind requireAuth (Phase 5B) — mounted separately in
// app.ts, before the auth gate. /healthz needs to stay reachable for
// uptime/load-balancer checks without credentials; /auth/* is how a client
// obtains credentials in the first place, so gating it would make login
// impossible.
export const publicRouter: IRouter = Router();
publicRouter.use(healthRouter);
publicRouter.use(authRouter);

// Everything else handles trading, config, or trade data — all mounted
// behind requireAuth in app.ts.
const router: IRouter = Router();

router.use(botRouter);
router.use(decisionsRouter);
router.use(scannerRouter);
router.use(marketRouter);
router.use(tradesRouter);
router.use(statsRouter);
router.use(memoryRouter);
router.use(configRouter);
// Autopsy first: backtests.ts declares GET /backtests/:id, which would
// otherwise swallow /backtests/autopsy as id="autopsy".
router.use(autopsyRouter);
router.use(backtestsRouter);
router.use(customStrategiesRouter);
router.use(strategiesRouter);
router.use(credentialsRouter);
router.use(reportsRouter);
router.use(accountRouter);

export default router;
