/**
 * TradeCore Pro — per-(user, section) bot engine registry
 *
 * Each user can run TWO fully independent trading sections at once — "crypto"
 * (Binance) and "forex" (OANDA) — each its own BotEngine instance with its own
 * scan loop, broker connection, config, strategies, positions and in-memory
 * tracking. This registry lazily constructs and caches one instance per
 * (userId, section); every route resolves `req.userId` + `req.section` through
 * here. A user with only crypto configured simply never instantiates the forex
 * engine.
 */
import { BotEngine } from "./botEngine";

/** The independent trading sections a user can run simultaneously. */
export type Section = "crypto" | "forex";
export const SECTIONS: readonly Section[] = ["crypto", "forex"] as const;

export function isSection(v: unknown): v is Section {
  return v === "crypto" || v === "forex";
}

const engines = new Map<string, BotEngine>();

const key = (userId: number, section: Section) => `${userId}:${section}`;

export function getOrCreateEngine(userId: number, section: Section = "crypto"): BotEngine {
  const k = key(userId, section);
  let engine = engines.get(k);
  if (!engine) {
    engine = new BotEngine(userId, section);
    engines.set(k, engine);
  }
  return engine;
}

/** All currently-instantiated engines — used by boot-time auto-resume. */
export function allEngines(): BotEngine[] {
  return Array.from(engines.values());
}
