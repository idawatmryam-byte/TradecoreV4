/**
 * TradeCore Pro — capture content hashes
 *
 * Kept separate from captureLog.ts (which pulls in the database) so the pure
 * test chain can verify hash stability without a DB.
 */
import { createHash } from "crypto";
import { canonicalJson } from "../plan/fingerprint";

/**
 * Stable content hash of a features object — the dedupe key for
 * capture.feature_snapshots. Identical indicator state at the same market
 * timestamp yields one snapshot row, however many strategies decided on it.
 */
export function snapshotHashOf(
  provider: string,
  venue: string,
  symbol: string,
  timeframe: string,
  dataTimestampMs: number,
  features: unknown,
): string {
  return createHash("sha256")
    .update(canonicalJson({ provider, venue, symbol, timeframe, dataTimestampMs, features }), "utf8")
    .digest("hex");
}

/**
 * Content hash of the strategy configuration in force when a decision was
 * made. This is the half of reproducibility the feature snapshot does not
 * carry: the same market read under a different risk budget or confidence
 * floor is a different decision, and a replay that ignores that is not a
 * replay.
 *
 * Truncated to 16 hex chars — collision risk is irrelevant for a provenance
 * label that is only ever compared for equality within one account.
 */
export function configVersionOf(configs: unknown): string {
  return createHash("sha256").update(canonicalJson(configs), "utf8").digest("hex").slice(0, 16);
}
