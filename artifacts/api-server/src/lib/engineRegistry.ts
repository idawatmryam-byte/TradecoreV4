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
/** Last time a request touched this (user, section). Drives the demo sweeper. */
const lastActivity = new Map<string, number>();

const key = (userId: number, section: Section) => `${userId}:${section}`;

export function getOrCreateEngine(
  userId: number,
  section: Section = "crypto",
  options: { resumeIdleDemo?: boolean } = {},
): BotEngine {
  const k = key(userId, section);
  lastActivity.set(k, Date.now());
  let engine = engines.get(k);
  if (!engine) {
    engine = new BotEngine(userId, section);
    engines.set(k, engine);
  } else if (options.resumeIdleDemo !== false && !engine.isRunning() && engine.isDemoTarget()) {
    // The user is back. A demo engine paused for inactivity resumes itself, so
    // session-scoping is invisible: nobody has to press Start again because
    // they went to lunch. Fire-and-forget — a request must never block on the
    // engine coming up, and an explicitly-stopped engine is left alone because
    // resumePausedDemo re-reads the desired-running flag first.
    void resumePausedDemo(k, engine);
  }
  return engine;
}

/** Keys with a resume attempt in flight, so a burst of requests starts one. */
const resuming = new Set<string>();

async function resumePausedDemo(k: string, engine: BotEngine): Promise<void> {
  if (resuming.has(k)) return;
  resuming.add(k);
  try {
    // Only revive what the user actually left switched on. An engine they
    // explicitly stopped has engineDesiredRunning=false and stays down.
    if (!(await engine.isDesiredRunning())) return;
    await engine.start();
  } catch {
    // Best-effort: a failed auto-resume must not break the request that
    // happened to trigger it. The user can still press Start.
  } finally {
    resuming.delete(k);
  }
}

/** All currently-instantiated engines — used by boot-time auto-resume. */
export function allEngines(): BotEngine[] {
  return Array.from(engines.values());
}

/** Mark a (user, section) as active without instantiating an engine. */
export function touchActivity(userId: number, section: Section): void {
  lastActivity.set(key(userId, section), Date.now());
}

// ---------------------------------------------------------------------------
// Session-scoped demo engines
//
// A live engine runs because the user is trading real money and expects it to
// keep running whether or not they are watching. A DEMO engine has no such
// claim: it is a simulation for someone evaluating the product, and leaving
// one scanning forever for every account that ever signed up is an always-on
// cost per signup with no revenue attached — the single largest infrastructure
// line item in the whole demo design.
//
// So demo engines are session-scoped: they run while the user is around and
// stop after a grace period of silence. Co-Pilot, Research, backtesting and
// every analytics surface keep working when stopped — only the scan loop
// pauses, and the next request starts it again.
//
// Live engines are NEVER touched by this. Stopping a real position's engine
// because nobody opened the dashboard would be dangerous.
// ---------------------------------------------------------------------------

/** How long a demo engine keeps scanning after the last sign of life. */
export const DEMO_IDLE_GRACE_MS = 30 * 60_000;

let sweeper: NodeJS.Timeout | null = null;

/**
 * Stop demo engines whose user has been quiet past the grace period.
 * Returns the (user, section) keys stopped — used by tests and diagnostics.
 */
export async function sweepIdleDemoEngines(now = Date.now(), graceMs = DEMO_IDLE_GRACE_MS): Promise<string[]> {
  const stopped: string[] = [];
  for (const [k, engine] of engines) {
    const idleFor = now - (lastActivity.get(k) ?? 0);
    if (idleFor < graceMs) continue;
    if (!engine.isRunning() || !engine.isDemoTarget()) continue;
    try {
      // pauseForIdle, not stop: the user's desired-running flag survives, so
      // the engine resumes on the next boot or the next time they return.
      await engine.pauseForIdle();
      stopped.push(k);
    } catch {
      // A failed stop must not stall the sweep for other users.
    }
  }
  return stopped;
}

/** Begin sweeping idle demo engines. Idempotent. */
export function startDemoSweeper(intervalMs = 5 * 60_000): void {
  if (sweeper) return;
  sweeper = setInterval(() => { void sweepIdleDemoEngines(); }, intervalMs);
  sweeper.unref?.();
}

export function stopDemoSweeper(): void {
  if (!sweeper) return;
  clearInterval(sweeper);
  sweeper = null;
}
