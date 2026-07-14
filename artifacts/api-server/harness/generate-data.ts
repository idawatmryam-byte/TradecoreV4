/**
 * TradeCore Pro — Backtest-Validation Harness: synthetic candle generator
 *
 * Writes reproducible 1m OHLCV into the `historical_candles` table so the
 * backtest engine (which reads ONLY from that table — see historicalData.ts)
 * can run fully offline, with no exchange access.
 *
 * WHY SYNTHETIC: this sandbox cannot reach any exchange — Binance is
 * geoblocked (HTTP 451) and every other host is blocked by the network
 * proxy. Synthetic data is a deliberate, honest tradeoff:
 *   - It CAN validate: harness correctness, that a code change compiles and
 *     runs end-to-end, and the RELATIVE effect of a one-variable change
 *     (baseline vs variant) on a FIXED, identical dataset. That is exactly
 *     what "change one thing and compare" needs.
 *   - It CANNOT validate: real-world profitability / edge. Synthetic price
 *     paths have no genuine market microstructure, so absolute P&L numbers
 *     are meaningless — only the DELTA between two runs on the same data is.
 *
 * REAL-DATA SWAP: everything downstream reads from `historical_candles`, so
 * on infrastructure that can reach Binance (e.g. the VPS), replace this step
 * with `ensureCandles()` (historicalData.ts) and the rest of the harness is
 * unchanged.
 *
 * DETERMINISM: a fixed seed per symbol → identical candles every run, so two
 * harness runs differ only by the code change under test, never by the data.
 *
 * Usage:
 *   tsx harness/generate-data.ts [--days N] [--end ISO]
 */
import { db, historicalCandlesTable } from "@workspace/db";
import { and, eq, gte, lte } from "drizzle-orm";

type Candle = [number, number, number, number, number, number];

// ── Deterministic RNG (mulberry32) + standard-normal via Box–Muller ─────────
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function makeRandn(rng: () => number): () => number {
  return () => {
    // Box–Muller; guard u1 away from 0 for the log.
    const u1 = Math.max(rng(), 1e-9);
    const u2 = rng();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };
}

// ── Regime cycle — each segment exercises different strategies ──────────────
// Lengths are in minutes; the cycle repeats for the whole date range.
type Regime = "uptrend" | "downtrend" | "range" | "high_vol" | "low_vol";
const SEGMENT_MINUTES = 6 * 60; // 6h per regime segment
const REGIME_CYCLE: Regime[] = ["uptrend", "range", "downtrend", "high_vol", "low_vol", "range"];

interface RegimeParams {
  /** per-minute drift as a fraction (e.g. 0.0001 = +0.01%/min) */
  drift: number;
  /** per-minute return noise standard deviation (fraction) */
  noise: number;
  /** mean-reversion pull toward the segment center (0 = none) */
  revert: number;
  /** probability a candle is a volume spike */
  spikeProb: number;
}
// Volatility is tuned to realistic 1m crypto levels so that TP/SL/trailing
// actually trigger within the strategies' holding windows (10–60m) — an
// earlier, quieter calibration timed out ~95% of trades, under-exercising
// the exit machinery. drift is per-minute directional bias; noise is the
// per-minute return σ; a random walk of σ over 60m ≈ σ·√60 of cumulative
// move, so σ≈0.0014 gives ~1% hourly swings — enough to reach 1–3% targets.
const REGIME_PARAMS: Record<Regime, RegimeParams> = {
  uptrend:   { drift:  0.00016, noise: 0.00075, revert: 0.0,   spikeProb: 0.07 },
  downtrend: { drift: -0.00016, noise: 0.00075, revert: 0.0,   spikeProb: 0.07 },
  range:     { drift:  0.0,     noise: 0.00095, revert: 0.03,  spikeProb: 0.04 },
  high_vol:  { drift:  0.0,     noise: 0.00260, revert: 0.005, spikeProb: 0.20 },
  low_vol:   { drift:  0.0,     noise: 0.00020, revert: 0.01,  spikeProb: 0.01 },
};

/** Baseline intrabar wick size (fraction of price) added on top of the
 *  return-driven body so 1m high–low ranges look realistic (~0.1–0.3%),
 *  which is what lets an SL/TP get touched intrabar rather than only on
 *  close-to-close drift. */
const BASE_WICK = 0.0009;

interface SymbolSpec { symbol: string; basePrice: number; seed: number; baseVol: number; }
const SYMBOLS: SymbolSpec[] = [
  { symbol: "BTCUSDT", basePrice: 60000, seed: 1001, baseVol: 120 },
  { symbol: "ETHUSDT", basePrice: 3000,  seed: 2002, baseVol: 900 },
  { symbol: "SOLUSDT", basePrice: 150,   seed: 3003, baseVol: 5000 },
];

const MINUTE_MS = 60_000;

function generateSymbol(spec: SymbolSpec, startMs: number, endMs: number): Candle[] {
  const rng = mulberry32(spec.seed);
  const randn = makeRandn(rng);
  const candles: Candle[] = [];

  let price = spec.basePrice;
  let segmentCenter = price;
  let ts = startMs;
  let minuteIndex = 0;

  while (ts <= endMs) {
    const regime = REGIME_CYCLE[Math.floor(minuteIndex / SEGMENT_MINUTES) % REGIME_CYCLE.length]!;
    const p = REGIME_PARAMS[regime];
    // Re-center at the start of each new segment so trends don't run away and
    // range segments oscillate around wherever price currently is.
    if (minuteIndex % SEGMENT_MINUTES === 0) segmentCenter = price;

    const open = price;
    const revertPull = p.revert * ((segmentCenter - open) / open);
    const ret = p.drift + revertPull + p.noise * randn();
    let close = open * (1 + ret);
    if (close <= 0) close = open * 0.999;

    // Intrabar extremes: wick beyond the body by a realistic base range plus
    // a regime-scaled component, so highs/lows actually reach nearby SL/TP.
    const wickUp = Math.abs(randn()) * (BASE_WICK + p.noise * 1.5);
    const wickDn = Math.abs(randn()) * (BASE_WICK + p.noise * 1.5);
    const high = Math.max(open, close) * (1 + wickUp);
    const low = Math.min(open, close) * (1 - wickDn);

    const spike = rng() < p.spikeProb ? 2 + rng() * 3 : 1; // 2×–5× on a spike
    const volume = spec.baseVol * (0.6 + rng() * 0.8) * spike;

    candles.push([ts, open, high, low, close, volume]);

    price = close;
    ts += MINUTE_MS;
    minuteIndex++;
  }

  return candles;
}

async function persist(symbol: string, candles: Candle[]): Promise<void> {
  const rows = candles.map((c) => ({
    symbol,
    timeframe: "1m",
    timestamp: c[0],
    open: c[1].toFixed(8),
    high: c[2].toFixed(8),
    low: c[3].toFixed(8),
    close: c[4].toFixed(8),
    volume: c[5].toFixed(8),
  }));
  for (let i = 0; i < rows.length; i += 500) {
    await db.insert(historicalCandlesTable).values(rows.slice(i, i + 500)).onConflictDoNothing();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const daysArg = args.indexOf("--days");
  const endArg = args.indexOf("--end");
  const days = daysArg >= 0 ? Number(args[daysArg + 1]) : 14;
  const endMs = endArg >= 0 ? new Date(args[endArg + 1]!).getTime() : Date.now();
  // Align end to a minute boundary for tidy timestamps.
  const alignedEnd = Math.floor(endMs / MINUTE_MS) * MINUTE_MS;
  const startMs = alignedEnd - days * 24 * 60 * MINUTE_MS;

  console.log(`Generating ${days}d of 1m synthetic candles per symbol`);
  console.log(`  range: ${new Date(startMs).toISOString()} → ${new Date(alignedEnd).toISOString()}`);

  for (const spec of SYMBOLS) {
    // Delete any existing rows in-range for this symbol/timeframe first so a
    // re-run is exactly reproducible (never a mix of old + new seeds).
    await db.delete(historicalCandlesTable).where(
      and(
        eq(historicalCandlesTable.symbol, spec.symbol),
        eq(historicalCandlesTable.timeframe, "1m"),
        gte(historicalCandlesTable.timestamp, startMs),
        lte(historicalCandlesTable.timestamp, alignedEnd),
      ),
    );
    const candles = generateSymbol(spec, startMs, alignedEnd);
    await persist(spec.symbol, candles);
    const closes = candles.map((c) => c[4]);
    console.log(
      `  ${spec.symbol}: ${candles.length} candles  ` +
        `price ${Math.min(...closes).toFixed(2)}–${Math.max(...closes).toFixed(2)}`,
    );
  }

  // Emit the window the harness runner should backtest over: leave a 6.5-day
  // pre-roll (the engine's downloadStart look-back is startDate − 6 days, since
  // WARMUP is now 100 bars) so every timeframe — including 100 hourly bars for
  // EMA50(1h) — is fully warmed up at the first tradeable candle.
  const runStart = new Date(startMs + Math.floor(6.5 * 24 * 60) * MINUTE_MS);
  const runEnd = new Date(alignedEnd);
  console.log("\nBacktest window to use (fully warmed up):");
  console.log(`  START=${runStart.toISOString()}`);
  console.log(`  END=${runEnd.toISOString()}`);

  await (await import("@workspace/db")).pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
