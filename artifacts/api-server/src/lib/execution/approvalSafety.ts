import type { LiveTicker } from "../decisionTrace";
import type { MarketState } from "../intelligence/market-state/types";

/** Return a spread only when both sides of the current quote are trustworthy. */
export function knownSpreadFraction(
  ticker: Pick<LiveTicker, "bid" | "ask"> | undefined,
): number | undefined {
  if (!ticker) return undefined;
  const bid = Number(ticker.bid);
  const ask = Number(ticker.ask);
  if (
    !Number.isFinite(bid) ||
    !Number.isFinite(ask) ||
    bid <= 0 ||
    ask <= 0 ||
    ask < bid
  ) {
    return undefined;
  }
  return (ask - bid) / ask;
}

/** Recompute freshness at approval time; creation-time status is not durable. */
export function marketStateFreshAt(
  state: Pick<MarketState, "dataTimestamp" | "freshness"> | undefined,
  now: Date,
): boolean {
  if (!state || !Number.isFinite(now.getTime())) return false;
  const dataTimestamp = Date.parse(state.dataTimestamp);
  const maximumAgeMs = Number(state.freshness.maximumAgeMs);
  if (
    !Number.isFinite(dataTimestamp) ||
    !Number.isFinite(maximumAgeMs) ||
    maximumAgeMs <= 0
  ) {
    return false;
  }
  const ageMs = now.getTime() - dataTimestamp;
  return ageMs >= 0 && ageMs <= maximumAgeMs;
}
