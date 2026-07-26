/**
 * TradeCore Pro — TradePlan fingerprint
 *
 * A content hash over the decision content of a TradePlan, so determinism
 * stops being an aspiration and becomes a property you can mechanically
 * check: replay a stored feature snapshot, re-derive the plan, compare the
 * hash. Equal hash ⇒ the engine made the identical trade decision.
 *
 * Two things this deliberately does NOT hash:
 *
 *   • `report` — the DecisionReport narrative. It is derived from the same
 *     inputs, so it adds no information, but it is prose: rewording a
 *     sentence would change the fingerprint of an identical trade. The
 *     fingerprint is about the TRADE, not the write-up.
 *   • `strategyName` — a display label. `strategyId` is the identity.
 *
 * And one thing it deliberately DOES include: `userId`. Without it, two users
 * running the same config against the same symbol on the same candle would
 * produce byte-identical payloads and collide on any UNIQUE index over the
 * fingerprint — silently dropping one user's plan.
 */
import { createHash } from "crypto";
import type { TradePlan } from "../strategies/base";

/**
 * Version of the fingerprint ALGORITHM (which fields are hashed and how they
 * are canonicalised) — not of the engine. Bump it when the hashed shape
 * changes, so old and new fingerprints are never silently compared as equal.
 */
export const FINGERPRINT_VERSION = 1;

/**
 * Deterministic JSON: object keys sorted, arrays order-preserving, undefined
 * dropped. Numbers use JavaScript's shortest round-trip representation, which
 * is specified behaviour (Number::toString) and therefore stable across Node
 * versions and platforms.
 *
 * Non-finite numbers throw rather than serialise. `JSON.stringify` turns them
 * into `null`, which would make a NaN price hash the same as a missing one —
 * a NaN reaching a TradePlan is a bug, and it should surface here loudly.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`canonicalJson: non-finite number (${value}) cannot be fingerprinted`);
    }
    // -0 and 0 are the same quantity; normalise so they hash identically.
    return JSON.stringify(value === 0 ? 0 : value);
  }

  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(",")}]`;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }

  throw new Error(`canonicalJson: unsupported value of type ${typeof value}`);
}

/**
 * The exact subset of a TradePlan that defines the trade decision. Anything
 * absent from this object cannot change the fingerprint.
 */
export function fingerprintPayload(userId: number, plan: TradePlan): Record<string, unknown> {
  return {
    v: FINGERPRINT_VERSION,
    userId,
    strategyId: plan.strategyId,
    symbol: plan.symbol,
    side: plan.side,
    confidence: plan.confidence,
    entryPrice: plan.entryPrice,
    slPrice: plan.slPrice,
    tpPrice: plan.tpPrice,
    qty: plan.qty,
    leverage: plan.leverage,
    expectedHoldSeconds: plan.expectedHoldSeconds,
    maxHoldSeconds: plan.maxHoldSeconds,
    regime: plan.regime,
    // Stamped centrally by the dispatcher; may legitimately be absent on a
    // plan that has not been through the reward:risk gate yet.
    netRewardRisk: plan.netRewardRisk ?? null,
  };
}

/** SHA-256 (hex) of the canonicalised decision content. 64 chars. */
export function planFingerprint(userId: number, plan: TradePlan): string {
  return createHash("sha256").update(canonicalJson(fingerprintPayload(userId, plan)), "utf8").digest("hex");
}
