/**
 * TradeCore Pro — forex market-hours model (pure, offline-testable)
 *
 * Crypto trades 24/7 so the engine never needed a calendar; forex doesn't:
 *
 *   - The FX market closes for the weekend at 17:00 New York time on Friday
 *     and reopens 17:00 NY on Sunday. NY observes DST, so in UTC that is
 *     21:00 (summer/EDT) or 22:00 (winter/EST) — computed here directly from
 *     the US DST rules (2nd Sunday of March 02:00 → 1st Sunday of November
 *     02:00 local) so no timezone library is needed.
 *   - Metals and index CFDs additionally take a daily one-hour break,
 *     17:00–18:00 NY (the CME Globex maintenance window), Monday–Thursday,
 *     and open an hour later on Sunday (18:00 NY).
 *   - Plain currency pairs trade continuously 24/5 between the weekend
 *     boundaries — no daily break.
 *
 * Used by the scan loop to (a) skip closed instruments' candle fetches and
 * entries and (b) show an honest "Market closed — next open …" decision
 * instead of evaluating signals against a frozen Friday close.
 */

/** OANDA instrument classes we distinguish (from instrument.type). */
export type InstrumentClass = "CURRENCY" | "METAL" | "CFD";

/** Is US Eastern time in DST at this UTC instant? DST runs from the 2nd
 *  Sunday of March 07:00 UTC (02:00 EST) to the 1st Sunday of November
 *  06:00 UTC (02:00 EDT). */
export function isUsEasternDst(utc: Date): boolean {
  const year = utc.getUTCFullYear();
  const dstStart = nthSundayUtc(year, 2, 2, 7);  // March, 2nd Sunday, 07:00 UTC
  const dstEnd = nthSundayUtc(year, 10, 1, 6);   // November, 1st Sunday, 06:00 UTC
  return utc.getTime() >= dstStart.getTime() && utc.getTime() < dstEnd.getTime();
}

function nthSundayUtc(year: number, month: number, n: number, hourUtc: number): Date {
  const firstDow = new Date(Date.UTC(year, month, 1)).getUTCDay();
  const day = 1 + ((7 - firstDow) % 7) + (n - 1) * 7;
  return new Date(Date.UTC(year, month, day, hourUtc));
}

/** The UTC hour at which "17:00 New York" falls on the given date. */
export function nyFivePmUtcHour(utc: Date): number {
  return isUsEasternDst(utc) ? 21 : 22;
}

/**
 * Is this instrument tradeable at `now`?
 *
 * CURRENCY: open except Fri 17:00 NY → Sun 17:00 NY.
 * METAL/CFD: same weekend, plus the daily 17:00–18:00 NY break Mon–Thu and
 * a Sunday open delayed to 18:00 NY.
 */
export function isInstrumentOpen(cls: InstrumentClass, now: Date): boolean {
  const closeHour = nyFivePmUtcHour(now);
  const day = now.getUTCDay();
  const hourFrac = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;

  // NOTE on day arithmetic: "Fri 17:00 NY" in UTC can be Friday 21/22:00 —
  // still the same UTC weekday (Fri=5) since the close hour is < 24.
  const weekendClosed =
    (day === 5 && hourFrac >= closeHour) || // Friday after close
    day === 6 ||                            // all Saturday
    (day === 0 && hourFrac < closeHour);    // Sunday before reopen

  if (weekendClosed) return false;
  if (cls === "CURRENCY") return true;

  // Metals/CFDs: daily maintenance break 17:00–18:00 NY (Mon–Thu after
  // close counts toward the NEXT day's session), and Sunday opens at 18:00.
  if (day === 0 && hourFrac < closeHour + 1) return false; // Sunday 17–18 NY
  if (day >= 1 && day <= 4 && hourFrac >= closeHour && hourFrac < closeHour + 1) return false;
  return true;
}

/** Next instant this instrument reopens (returns `now` if already open). */
export function nextInstrumentOpen(cls: InstrumentClass, now: Date): Date {
  if (isInstrumentOpen(cls, now)) return now;
  // Step forward in 5-minute increments to the next open boundary — bounded
  // by the longest possible closure (a weekend, ~49h → ≤ 600 steps). Chosen
  // over closed-form boundary math so ONE definition of "open" (above) can
  // never disagree with this function across DST transitions.
  const step = 5 * 60_000;
  let t = Math.floor(now.getTime() / step) * step;
  for (let i = 0; i < 60 * 24 * 3; i++) {
    t += step;
    const candidate = new Date(t);
    if (isInstrumentOpen(cls, candidate)) return candidate;
  }
  return new Date(t); // unreachable in practice
}

/** Next instant this instrument closes (returns `now` if already closed).
 *  Same stepping approach as nextInstrumentOpen so the one `isInstrumentOpen`
 *  predicate stays the single source of truth. Longest open stretch is the
 *  trading week (~5 days), so the bound is 7 days of 5-minute steps. */
export function nextInstrumentClose(cls: InstrumentClass, now: Date): Date {
  if (!isInstrumentOpen(cls, now)) return now;
  const step = 5 * 60_000;
  let t = Math.floor(now.getTime() / step) * step;
  for (let i = 0; i < (60 / 5) * 24 * 7; i++) {
    t += step;
    const candidate = new Date(t);
    if (!isInstrumentOpen(cls, candidate)) return candidate;
  }
  return new Date(t); // unreachable in practice
}

/** Coerce an OANDA instrument.type string to a known class (default CURRENCY). */
export function instrumentClassOf(raw: unknown): InstrumentClass {
  return raw === "METAL" || raw === "CFD" ? raw : "CURRENCY";
}
