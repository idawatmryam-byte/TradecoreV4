/**
 * TradeCore Pro — Security headers & CORS  (Phase 5B, Production Hardening)
 *
 * BEFORE: `app.use(cors())` with no options — the `cors` package's default
 * with no `origin` set reflects whatever `Origin` header the request sent,
 * i.e. any website could make credentialed cross-origin requests against
 * this API from a visitor's browser. Combined with zero authentication,
 * this meant literally any webpage a browser happened to load could talk to
 * this trading bot's API on the visitor's behalf.
 *
 * AFTER: an explicit allow-list from `ALLOWED_ORIGINS` (empty by default —
 * same-origin only, which is all this app needs since the frontend is
 * served by this same Express app). Cross-origin access is opt-in per
 * origin, not opt-out.
 */
import cors from "cors";
import type { CorsOptions } from "cors";
import type { NextFunction, Request, Response } from "express";
import { validateEnv } from "../lib/env";

export function buildCorsOptions(): CorsOptions {
  const { allowedOrigins } = validateEnv();

  return {
    origin(origin, callback) {
      // No Origin header (same-origin requests, curl, server-to-server) — allow.
      if (!origin) {
        callback(null, true);
        return;
      }
      if (allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error(`Origin "${origin}" is not allowed by ALLOWED_ORIGINS`));
    },
    credentials: true, // required so the browser will send the session cookie cross-origin
  };
}

export const corsMiddleware = () => cors(buildCorsOptions());

/**
 * A few defense-in-depth response headers. Not a full `helmet` install
 * (no network access to add the dependency in this pass) but the same
 * package is a clean drop-in later if you want the fuller header set
 * (CSP, COEP, etc. tuned for the frontend's asset loading).
 */
export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  const { nodeEnv } = validateEnv();
  if (nodeEnv === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  }
  next();
}
