/**
 * Offline verification for src/lib/marketHours.ts — the forex calendar:
 * US-DST boundary math, the weekend close (Fri/Sun 17:00 New York in both
 * EDT and EST), the metals/CFD daily maintenance break, and nextInstrumentOpen.
 *
 * Run:  tsx harness/market-hours.test.ts   (exit 0 = all pass)
 */
import { isUsEasternDst, nyFivePmUtcHour, isInstrumentOpen, nextInstrumentOpen, nextInstrumentClose, instrumentClassOf } from "../src/lib/marketHours";

let failures = 0;
function expect(name: string, actual: unknown, wanted: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(wanted);
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗ FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(actual)}, wanted ${JSON.stringify(wanted)})`}`);
}
const at = (iso: string) => new Date(iso);

// ── US DST boundaries (2026: starts Sun Mar 8, ends Sun Nov 1) ──────────────
expect("mid-summer is EDT", isUsEasternDst(at("2026-07-01T12:00:00Z")), true);
expect("mid-winter is EST", isUsEasternDst(at("2026-01-15T12:00:00Z")), false);
expect("minute before DST start", isUsEasternDst(at("2026-03-08T06:59:00Z")), false);
expect("DST start instant", isUsEasternDst(at("2026-03-08T07:00:00Z")), true);
expect("minute before DST end", isUsEasternDst(at("2026-11-01T05:59:00Z")), true);
expect("DST end instant", isUsEasternDst(at("2026-11-01T06:00:00Z")), false);
expect("NY 5pm = 21:00 UTC in summer", nyFivePmUtcHour(at("2026-07-01T00:00:00Z")), 21);
expect("NY 5pm = 22:00 UTC in winter", nyFivePmUtcHour(at("2026-01-15T00:00:00Z")), 22);

// ── Weekend close, currency pairs (summer/EDT: 21:00 UTC boundary) ──────────
expect("Fri 20:59 UTC open (EDT)", isInstrumentOpen("CURRENCY", at("2026-07-17T20:59:00Z")), true);
expect("Fri 21:00 UTC closed (EDT)", isInstrumentOpen("CURRENCY", at("2026-07-17T21:00:00Z")), false);
expect("Saturday closed", isInstrumentOpen("CURRENCY", at("2026-07-18T12:00:00Z")), false);
expect("Sun 20:59 UTC still closed", isInstrumentOpen("CURRENCY", at("2026-07-19T20:59:00Z")), false);
expect("Sun 21:00 UTC open (EDT)", isInstrumentOpen("CURRENCY", at("2026-07-19T21:00:00Z")), true);
expect("mid-week Wednesday open", isInstrumentOpen("CURRENCY", at("2026-07-15T12:00:00Z")), true);

// ── Weekend close in winter (EST: 22:00 UTC boundary) ───────────────────────
expect("Fri 21:30 UTC open (EST)", isInstrumentOpen("CURRENCY", at("2026-01-16T21:30:00Z")), true);
expect("Fri 22:00 UTC closed (EST)", isInstrumentOpen("CURRENCY", at("2026-01-16T22:00:00Z")), false);
expect("Sun 22:00 UTC open (EST)", isInstrumentOpen("CURRENCY", at("2026-01-18T22:00:00Z")), true);

// ── Metals/CFD daily break (17:00–18:00 NY = 21–22 UTC in EDT) ──────────────
expect("gold Mon 21:30 UTC in daily break", isInstrumentOpen("METAL", at("2026-07-13T21:30:00Z")), false);
expect("currency Mon 21:30 UTC unaffected", isInstrumentOpen("CURRENCY", at("2026-07-13T21:30:00Z")), true);
expect("gold Mon 22:00 UTC reopens", isInstrumentOpen("METAL", at("2026-07-13T22:00:00Z")), true);
expect("gold Sunday opens an hour late", isInstrumentOpen("METAL", at("2026-07-19T21:30:00Z")), false);
expect("gold Sunday 22:00 UTC open", isInstrumentOpen("METAL", at("2026-07-19T22:00:00Z")), true);
expect("CFD behaves like metal", isInstrumentOpen("CFD", at("2026-07-13T21:30:00Z")), false);

// ── nextInstrumentOpen ──────────────────────────────────────────────────────
expect(
  "Saturday noon → Sunday 21:00 UTC (currency, EDT)",
  nextInstrumentOpen("CURRENCY", at("2026-07-18T12:00:00Z")).toISOString(),
  "2026-07-19T21:00:00.000Z",
);
expect(
  "gold in daily break → 22:00 UTC same day",
  nextInstrumentOpen("METAL", at("2026-07-13T21:10:00Z")).toISOString(),
  "2026-07-13T22:00:00.000Z",
);
expect(
  "already open returns now",
  nextInstrumentOpen("CURRENCY", at("2026-07-15T12:00:00Z")).toISOString(),
  "2026-07-15T12:00:00.000Z",
);

// ── nextInstrumentClose (feeds the dashboard "closes Fri 21:00" banner) ─────
expect(
  "Wednesday noon → Friday 21:00 UTC weekend close (currency, EDT)",
  nextInstrumentClose("CURRENCY", at("2026-07-15T12:00:00Z")).toISOString(),
  "2026-07-17T21:00:00.000Z",
);
expect(
  "gold Monday noon → same-day 21:00 UTC daily break",
  nextInstrumentClose("METAL", at("2026-07-13T12:00:00Z")).toISOString(),
  "2026-07-13T21:00:00.000Z",
);
expect(
  "winter Friday → 22:00 UTC close (EST)",
  nextInstrumentClose("CURRENCY", at("2026-01-16T12:00:00Z")).toISOString(),
  "2026-01-16T22:00:00.000Z",
);
expect(
  "already closed returns now",
  nextInstrumentClose("CURRENCY", at("2026-07-18T12:00:00Z")).toISOString(),
  "2026-07-18T12:00:00.000Z",
);

// ── instrumentClassOf coercion ──────────────────────────────────────────────
expect("METAL passes through", instrumentClassOf("METAL"), "METAL");
expect("CFD passes through", instrumentClassOf("CFD"), "CFD");
expect("unknown → CURRENCY", instrumentClassOf("something"), "CURRENCY");
expect("undefined → CURRENCY", instrumentClassOf(undefined), "CURRENCY");

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll market-hours checks passed.");
