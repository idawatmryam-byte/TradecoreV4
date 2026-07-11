/**
 * TradeCore Pro — Canonical Exit Reasons  (Phase 4A)
 *
 * Single source of truth for every reason a trade may close. ExitManager is
 * the only code allowed to write one of these into `trades.exit_reason` for
 * a LIVE trade-management decision, and it rejects (falls back to "manual" +
 * a loud log) anything outside this set — "Unknown exit reasons are not
 * allowed." One deliberate exception: `botEngine.reconcileMissingPosition()`
 * (Phase 5B) writes `reconciled_missing` directly, since a startup-
 * reconciliation finding is not a live trade-management decision at all —
 * it's closing the DB's record of a position that already closed itself
 * while the bot was offline. Still drawn from this same canonical set so
 * every writer of `exit_reason` — live or administrative — is validated
 * against one list, not two.
 *
 * Naming note: the Phase 4 spec calls the time-based exit "TIME_LIMIT". This
 * codebase — and the already-shipped API contract in
 * lib/api-spec/openapi.yaml + the generated zod client — stores it as
 * "timeout". Renaming the literal would break the existing OpenAPI contract
 * and any historical rows already written with that value, so "timeout" is
 * kept as the on-the-wire value and treated as the TIME_LIMIT case
 * everywhere in this codebase. Every other Phase 4 reason is new and uses
 * the lowercase snake_case convention already established by the four
 * original values (take_profit, stop_loss, manual, timeout).
 */

export const EXIT_REASONS = [
  "stop_loss", // STOP_LOSS
  "take_profit", // TAKE_PROFIT
  "signal_exit", // SIGNAL_EXIT      — strategy signal reversed/invalidated (Phase 4B)
  "timeout", // TIME_LIMIT       — max holding time exceeded (kept as "timeout" for API compat)
  "break_even", // BREAK_EVEN       — SL moved to break-even and hit (Phase 4B)
  "trailing_stop", // TRAILING_STOP    — ATR/percent/dynamic trailing stop hit (Phase 4B)
  "manual", // MANUAL
  "emergency_stop", // EMERGENCY_STOP   — risk-guard/unprotected-position forced close
  "circuit_breaker", // CIRCUIT_BREAKER  — daily loss limit forced close
  "reconciled_missing", // RECONCILED_MISSING — startup reconciliation found the DB said open but the exchange balance didn't back it (closed while the bot was offline); see botEngine.ts reconcileMissingPosition() (Phase 5B)
  "end_of_backtest", // END_OF_BACKTEST — backtest date range ended with the position still open; NOT a genuine maxHoldingSeconds timeout (Phase 6 audit Flaw 2 fix — these used to be mislabeled "timeout", inflating that count and polluting exit-reason statistics). Backtest-only; never written by ExitManager.
] as const;

export type ExitReason = (typeof EXIT_REASONS)[number];

const EXIT_REASON_SET: ReadonlySet<string> = new Set(EXIT_REASONS);

export function isValidExitReason(value: unknown): value is ExitReason {
  return typeof value === "string" && EXIT_REASON_SET.has(value);
}

/**
 * Normalize an arbitrary string into a valid ExitReason, defaulting to
 * "manual" (and flagging it) if it isn't recognized. Callers should log when
 * `wasUnknown` is true — it means something tried to close a trade with a
 * reason outside the canonical set.
 */
export function normalizeExitReason(value: string): { reason: ExitReason; wasUnknown: boolean } {
  if (isValidExitReason(value)) return { reason: value, wasUnknown: false };
  return { reason: "manual", wasUnknown: true };
}
