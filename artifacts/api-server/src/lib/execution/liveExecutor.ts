/**
 * TradeCore Pro — LiveExecutor
 *
 * Places real orders with real money. It is the executor the engine has
 * always been, now named and reachable through the TradeExecutor interface so
 * DemoExecutor and RecommendExecutor can take its place without the scan loop
 * knowing the difference.
 *
 * The order path itself still lives in BotEngine.enterTrade(), injected here
 * as a function. That is deliberate: enterTrade is wired into the exchange
 * handle, balance lookups, cooldowns, orphan sweeping, order-id tracking,
 * ExitManager and alerting, and relocating it would be a large diff across the
 * money path for no capability gained today. What matters for the other
 * executors is the SEAM — they consume a TradePlan, not enterTrade's guts.
 *
 * This class is also where live-only gating belongs when it arrives: the Pro
 * entitlement check before real execution, and the kill-switch. Neither is
 * built yet; both have exactly one correct home.
 */
import type { ExecutionRequest, ExecutionResult, TradeExecutor } from "./executor";

/** The real order path, injected so this module never imports BotEngine. */
export type LiveOrderPlacer = (req: ExecutionRequest) => Promise<ExecutionResult>;

export class LiveExecutor implements TradeExecutor {
  readonly kind = "live" as const;

  constructor(private readonly place: LiveOrderPlacer) {}

  execute(req: ExecutionRequest): Promise<ExecutionResult> {
    return this.place(req);
  }
}

/**
 * Research mode: the pipeline runs in full and the plan is produced, analysed,
 * and captured — but execution is unreachable by construction. Not a flag
 * checked before placing an order (which could be forgotten on a new code
 * path) but an executor with no order path at all.
 */
export class ResearchExecutor implements TradeExecutor {
  // Reported as "recommend" because, like Co-Pilot, it declines to act on the
  // plan itself; the difference is that Research offers no way to act later.
  readonly kind = "recommend" as const;

  async execute(req: ExecutionRequest): Promise<ExecutionResult> {
    return {
      entered: false,
      reason: `Research mode — plan produced and recorded for ${req.symbol}, execution disabled`,
    };
  }
}
