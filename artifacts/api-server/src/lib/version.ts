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
 * The version stamped when the decision core read NO memory at all — the
 * default, and what every account runs until gated influence (P8) is
 * explicitly enabled and approved.
 *
 * A decision captured under "memory-0" is reproducible from its features and
 * config alone. Once influence is active the scan stamps the live state's
 * version instead ("memory-1:<hash>", see lib/memory/influence.ts), because
 * the acting rules are then a third input to the outcome and a replay that
 * ignored them would not reproduce it.
 */
export const MEMORY_VERSION_NONE = "memory-0";
