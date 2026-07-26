/**
 * TradeCore Pro — engine version
 *
 * Stamped on every captured decision so a replay years from now can be pinned
 * to the engine that produced it. A captured decision without this is a fact
 * with no context: you can see WHAT was decided but not what logic decided it.
 *
 * BUMP THIS whenever a change alters what the decision core computes —
 * feature extraction, regime detection, strategy logic, risk gating, SL/TP
 * geometry. Do NOT bump for UI, routes, logging, or storage changes: a version
 * that moves for cosmetic reasons is noise, and one that stays still through a
 * behaviour change is a lie.
 *
 * The parity harness is the test for whether a change warrants a bump: if
 * `compare.ts` shows a non-zero delta, the engine version must move.
 */
export const ENGINE_VERSION = "1.0.0";

/**
 * MemoryState version in force. Fixed until gated memory influence ships —
 * "memory-0" means the decision core reads no memory at all, so a replay under
 * it is reproducible from features and config alone.
 */
export const MEMORY_VERSION_NONE = "memory-0";
