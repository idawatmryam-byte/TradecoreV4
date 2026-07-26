/**
 * TradeCore Pro — execution identifiers
 *
 * Kept separate from intentLog.ts (which pulls in the database) so the pure
 * test chain can verify the client-order-id format without a DB.
 */
import { randomUUID } from "crypto";

/**
 * The id sent to the broker as its own order reference (Binance
 * `newClientOrderId`). After a timeout this is how an order is looked up
 * rather than blindly resubmitted — resubmitting a market order that may
 * already have filled doubles a real position.
 *
 * Binance accepts `^[\.A-Z\:/a-z0-9_-]{1,36}$`. This stays inside the safe
 * subset and well inside the length cap, and is unique per attempt so a retry
 * can never be mistaken for the original submission.
 *
 * Layout: `tc-<userId>-<base36 millis>-<8 hex>` — 8 hex chars is ample to
 * avoid collision within one account, and the whole id stays ≤ 36 characters
 * even for the largest int4 userId.
 */
export function makeClientOrderId(userId: number): string {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 8);
  return `tc-${userId}-${Date.now().toString(36)}-${suffix}`;
}
