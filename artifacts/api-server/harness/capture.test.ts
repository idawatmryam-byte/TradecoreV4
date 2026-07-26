/**
 * CAPTURE-HASH test — the dedupe and provenance keys of the capture log.
 *
 * Two properties the historical asset depends on:
 *
 *   • Snapshot hashes are pure content hashes, so N strategies deciding on the
 *     same symbol in the same scan share ONE feature_snapshots row instead of
 *     storing N identical copies. Get this wrong in the loose direction and
 *     storage multiplies; get it wrong in the tight direction and two genuinely
 *     different market states collapse into one, silently corrupting every
 *     statistic computed from them later.
 *
 *   • Config version moves when the configuration that produced a decision
 *     moves. The same market read under a different risk budget is a different
 *     decision, and a replay that ignores that is not a replay.
 *
 * Pure — no DB, no network.
 *
 * Run:  tsx harness/capture.test.ts   (exit 0 = pass)
 */
import { configVersionOf, snapshotHashOf } from "../src/lib/capture/hashing";

let failures = 0;
function expect(name: string, cond: boolean, detail = "") {
  if (!cond) {
    failures++;
    console.error(`✗  ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    console.log(`✓  ${name}`);
  }
}

const T = Date.UTC(2025, 5, 1, 12, 0, 0);
const features = { confidence: 72, rsi: 41.5, adx: 28, regime: "trend", atrPercent: 0.42, macroBullish: true };
const base = () => snapshotHashOf("binance", "spot", "BTCUSDT", "1m", T, features);

// ── Snapshot hash: stable, and sensitive to everything that matters ─────────

expect("snapshot hash is 64-char hex", /^[0-9a-f]{64}$/.test(base()));
expect("same inputs ⇒ same hash (the dedupe key)", base() === base());
expect(
  "key order in the features object is irrelevant",
  base() === snapshotHashOf("binance", "spot", "BTCUSDT", "1m", T, {
    macroBullish: true, atrPercent: 0.42, regime: "trend", adx: 28, rsi: 41.5, confidence: 72,
  }),
);

const mustDiffer: Array<[string, string]> = [
  ["provider", snapshotHashOf("oanda", "spot", "BTCUSDT", "1m", T, features)],
  ["venue", snapshotHashOf("binance", "futures", "BTCUSDT", "1m", T, features)],
  ["symbol", snapshotHashOf("binance", "spot", "ETHUSDT", "1m", T, features)],
  ["timeframe", snapshotHashOf("binance", "spot", "BTCUSDT", "5m", T, features)],
  ["market timestamp", snapshotHashOf("binance", "spot", "BTCUSDT", "1m", T + 60_000, features)],
  ["a feature value", snapshotHashOf("binance", "spot", "BTCUSDT", "1m", T, { ...features, rsi: 41.6 })],
  ["an added feature", snapshotHashOf("binance", "spot", "BTCUSDT", "1m", T, { ...features, newIndicator: 1 })],
];
for (const [what, hash] of mustDiffer) {
  expect(`different ${what} ⇒ different hash`, hash !== base());
}

// The nastiest collision to avoid: same candle, different symbol, identical
// indicator readings. Without symbol in the hash these would share a snapshot
// and every per-symbol statistic downstream would be wrong.
expect(
  "identical readings on two symbols stay distinct",
  snapshotHashOf("binance", "spot", "BTCUSDT", "1m", T, features) !==
    snapshotHashOf("binance", "spot", "SOLUSDT", "1m", T, features),
);

// A NaN reaching a captured snapshot is a bug; it must surface, not serialise
// to null and hash equal to a missing reading.
let threw = false;
try { snapshotHashOf("binance", "spot", "BTCUSDT", "1m", T, { rsi: NaN }); } catch { threw = true; }
expect("a NaN feature throws rather than hashing as null", threw);

// ── Config version ──────────────────────────────────────────────────────────

const cfgA = { trend_pullback: { maxLossUsdt: 25, confidenceThreshold: 60 } };
const cfgB = { trend_pullback: { maxLossUsdt: 50, confidenceThreshold: 60 } };

expect("config version is 16-char hex", /^[0-9a-f]{16}$/.test(configVersionOf(cfgA)));
expect("same config ⇒ same version", configVersionOf(cfgA) === configVersionOf(cfgA));
expect("changed risk budget ⇒ different version", configVersionOf(cfgA) !== configVersionOf(cfgB));
expect(
  "key order does not churn the version",
  configVersionOf({ trend_pullback: { confidenceThreshold: 60, maxLossUsdt: 25 } }) === configVersionOf(cfgA),
);
expect(
  "adding a strategy changes the version",
  configVersionOf({ ...cfgA, mean_reversion: { maxLossUsdt: 10 } }) !== configVersionOf(cfgA),
);

console.log(failures === 0 ? "\nAll capture-hash checks passed." : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
