/**
 * TradeCore Pro — per-user bot engine registry (Multi-user Phase)
 *
 * Each user runs their own fully independent BotEngine instance — own
 * scan loop, own exchange connection, own in-memory order tracking. This
 * registry lazily constructs and caches one instance per userId; every
 * route resolves `req.userId` (set by requireAuth) through here instead of
 * importing a shared singleton.
 */
import { BotEngine } from "./botEngine";

const engines = new Map<number, BotEngine>();

export function getOrCreateEngine(userId: number): BotEngine {
  let engine = engines.get(userId);
  if (!engine) {
    engine = new BotEngine(userId);
    engines.set(userId, engine);
  }
  return engine;
}
