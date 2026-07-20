/**
 * TradeCore Pro — Demo read-only guard
 *
 * The demo account (users.isDemo, entered via POST /auth/demo) exists so a
 * prospect can explore the fully-populated product with no signup and no
 * exchange keys. It must be able to VIEW everything and CHANGE nothing — a
 * demo user reaching a live order path, a credential write, or a config edit
 * would be a real problem.
 *
 * This is the single server-side enforcement point (the frontend also
 * disables the controls, but that is cosmetic). Rule: for a demo user, any
 * non-idempotent method (anything other than GET/HEAD/OPTIONS) is rejected
 * with a friendly 403. Every read path is a GET, so the entire product stays
 * viewable. Belt-and-suspenders: the demo user is seeded with NO exchange
 * credentials, so even a missed route physically cannot place an order.
 *
 * Mounted AFTER requireAuth (needs req.userId) and before the app router.
 * Demo-user membership is cached in-process (the seeded `demo` account is
 * effectively static) so this adds no per-request DB round-trip on the hot
 * read path.
 */
import type { NextFunction, Request, Response } from "express";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// userId → isDemo, cached with a short TTL. The demo account never toggles at
// runtime, so a 60s cache is plenty and keeps mutations' guard check cheap.
const demoCache = new Map<number, { isDemo: boolean; at: number }>();
const CACHE_TTL_MS = 60_000;

export async function isDemoUser(userId: number): Promise<boolean> {
  const hit = demoCache.get(userId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.isDemo;
  const [row] = await db
    .select({ isDemo: usersTable.isDemo })
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  const isDemo = row?.isDemo ?? false;
  demoCache.set(userId, { isDemo, at: Date.now() });
  return isDemo;
}

export async function demoGuard(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (SAFE_METHODS.has(req.method) || req.userId == null) {
    next();
    return;
  }
  if (await isDemoUser(req.userId)) {
    logger.info({ userId: req.userId, method: req.method, path: req.path }, "DEMO_MUTATION_BLOCKED");
    res.status(403).json({
      error: "This is a read-only demo. Create a free account to connect your own keys and run the engine.",
      demo: true,
    });
    return;
  }
  next();
}
