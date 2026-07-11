/**
 * TradeCore Pro — Rate limiting  (Phase 5B, Production Hardening)
 *
 * A small in-memory, fixed-window rate limiter. Not pulled from
 * `express-rate-limit` because this sandbox has no network access to add a
 * new dependency — but there is nothing exotic here, and swapping in
 * `express-rate-limit` later (a well-audited, battle-tested package) is a
 * clean drop-in replacement whenever `pnpm install` is available. If you
 * ever run more than one API server process/instance behind a load
 * balancer, this in-memory approach stops being accurate (each process has
 * its own counters) — fine for this project's single-process deployment,
 * but flagged here so it isn't silently wrong if that changes.
 */
import type { NextFunction, Request, Response } from "express";
import { logger } from "../lib/logger";

interface Bucket {
  count: number;
  resetAt: number;
}

export interface RateLimitOptions {
  /** Rolling window size in ms. */
  windowMs: number;
  /** Max requests per key per window. */
  max: number;
  /** How to key requests — defaults to remote IP. */
  keyFn?: (req: Request) => string;
  /** Log tag for the warning emitted when a request is throttled. */
  name: string;
}

export function rateLimit(opts: RateLimitOptions) {
  const buckets = new Map<string, Bucket>();
  const keyFn = opts.keyFn ?? ((req: Request) => req.ip ?? "unknown");

  // Periodic sweep so `buckets` doesn't grow unbounded with one-off IPs.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }, Math.max(opts.windowMs, 60_000));
  sweep.unref?.(); // never keep the process alive just for this

  return function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
    const key = keyFn(req);
    const now = Date.now();
    const existing = buckets.get(key);

    if (!existing || existing.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + opts.windowMs });
      next();
      return;
    }

    existing.count += 1;
    if (existing.count > opts.max) {
      const retryAfterSec = Math.ceil((existing.resetAt - now) / 1000);
      res.setHeader("Retry-After", String(retryAfterSec));
      logger.warn(
        { key, path: req.path, limiter: opts.name, count: existing.count },
        "RATE_LIMIT_EXCEEDED",
      );
      res.status(429).json({ error: "Too many requests", retryAfterSeconds: retryAfterSec });
      return;
    }

    next();
  };
}
