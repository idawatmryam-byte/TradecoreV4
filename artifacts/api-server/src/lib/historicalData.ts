/**
 * TradeCore Pro — Historical Candle Downloader
 *
 * Fetches OHLCV data from Binance public REST API (no auth required),
 * caches everything in PostgreSQL, and only downloads missing candles.
 */

import { db } from "@workspace/db";
import { historicalCandlesTable } from "@workspace/db";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { logger } from "./logger";

export type Candle = [number, number, number, number, number, number];

const BINANCE_BASE = "https://api.binance.com/api/v3";
const BATCH_SIZE = 1000; // Binance max per request
const DELAY_MS = 250;    // polite rate limiting between batches

const TF_MS: Record<string, number> = {
  "1m":   60_000,
  "3m":   3 * 60_000,
  "5m":   5 * 60_000,
  "15m":  15 * 60_000,
  "30m":  30 * 60_000,
  "1h":   60 * 60_000,
  "4h":   4 * 60 * 60_000,
  "1d":   24 * 60 * 60_000,
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Fetch a single batch of candles from Binance public API */
async function fetchBatch(
  symbol: string,
  timeframe: string,
  startMs: number,
  endMs: number
): Promise<Candle[]> {
  const url =
    `${BINANCE_BASE}/klines` +
    `?symbol=${symbol}` +
    `&interval=${timeframe}` +
    `&startTime=${startMs}` +
    `&endTime=${endMs}` +
    `&limit=${BATCH_SIZE}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Binance klines HTTP ${res.status} for ${symbol} ${timeframe}`);
  }
  const data = await res.json() as any[][];
  return data.map((c) => [
    Number(c[0]), // timestamp ms
    Number(c[1]), // open
    Number(c[2]), // high
    Number(c[3]), // low
    Number(c[4]), // close
    Number(c[5]), // volume
  ] as Candle);
}

/** Insert candles into DB, ignoring conflicts (already-cached candles) */
async function persistCandles(
  symbol: string,
  timeframe: string,
  candles: Candle[]
): Promise<void> {
  if (candles.length === 0) return;
  const rows = candles.map((c) => ({
    symbol,
    timeframe,
    timestamp: c[0],
    open: c[1].toFixed(8),
    high: c[2].toFixed(8),
    low: c[3].toFixed(8),
    close: c[4].toFixed(8),
    volume: c[5].toFixed(8),
  }));

  // Batch insert in chunks of 500 to stay within parameter limits
  for (let i = 0; i < rows.length; i += 500) {
    await db
      .insert(historicalCandlesTable)
      .values(rows.slice(i, i + 500))
      .onConflictDoNothing();
  }
}

/**
 * Get the timestamp range and count already cached in DB for a symbol/timeframe.
 * Returns { minTs, maxTs, count } or null if nothing is cached.
 */
async function getCachedRange(
  symbol: string,
  timeframe: string,
  startMs: number,
  endMs: number
): Promise<{ minTs: number; maxTs: number; count: number } | null> {
  const rows = await db
    .select({
      minTs: sql<number>`min(${historicalCandlesTable.timestamp})`,
      maxTs: sql<number>`max(${historicalCandlesTable.timestamp})`,
      count: sql<number>`count(*)`,
    })
    .from(historicalCandlesTable)
    .where(
      and(
        eq(historicalCandlesTable.symbol, symbol),
        eq(historicalCandlesTable.timeframe, timeframe),
        gte(historicalCandlesTable.timestamp, startMs),
        lte(historicalCandlesTable.timestamp, endMs)
      )
    );

  const row = rows[0];
  if (!row || row.minTs == null) return null;
  return { minTs: Number(row.minTs), maxTs: Number(row.maxTs), count: Number(row.count) };
}

/**
 * Download historical candles for a symbol/timeframe/date range.
 * Uses boundary + count-based gap detection: if the cached candle count is
 * significantly less than expected it downloads the full range again
 * (conflicts are ignored so no data is overwritten).
 */
export async function ensureCandles(
  symbol: string,
  timeframe: string,
  startMs: number,
  endMs: number,
  onProgress?: (downloaded: number) => void
): Promise<void> {
  const tfMs = TF_MS[timeframe];
  if (!tfMs) throw new Error(`Unsupported timeframe: ${timeframe}`);

  const cached = await getCachedRange(symbol, timeframe, startMs, endMs);

  // Expected number of candles in [startMs, endMs]
  const expectedCount = Math.floor((endMs - startMs) / tfMs) + 1;

  // Build list of gaps to download
  const gaps: Array<{ from: number; to: number }> = [];

  if (!cached) {
    // Nothing cached — download everything
    gaps.push({ from: startMs, to: endMs });
  } else {
    // Count-based hole detection: if we have < 90% of expected candles,
    // re-download the full range (onConflictDoNothing prevents double-writes).
    const coverage = cached.count / expectedCount;
    if (coverage < 0.90) {
      logger.warn(
        { symbol, timeframe, cached: cached.count, expected: expectedCount, coverage: coverage.toFixed(2) },
        "Detected internal gaps in cached candles — re-downloading full range"
      );
      gaps.push({ from: startMs, to: endMs });
    } else {
      // Boundary gaps only
      if (startMs < cached.minTs - tfMs) {
        gaps.push({ from: startMs, to: cached.minTs - tfMs });
      }
      if (endMs > cached.maxTs + tfMs) {
        gaps.push({ from: cached.maxTs + tfMs, to: endMs });
      }
    }
  }

  if (gaps.length === 0) {
    logger.info({ symbol, timeframe }, "Candles already cached, skipping download");
    return;
  }

  let totalDownloaded = 0;

  for (const gap of gaps) {
    let cursor = gap.from;
    while (cursor <= gap.to) {
      const batchEnd = Math.min(cursor + tfMs * BATCH_SIZE - tfMs, gap.to);
      logger.info(
        { symbol, timeframe, from: new Date(cursor).toISOString(), to: new Date(batchEnd).toISOString() },
        "Downloading candle batch"
      );

      const candles = await fetchBatch(symbol, timeframe, cursor, batchEnd);
      if (candles.length === 0) break;

      await persistCandles(symbol, timeframe, candles);
      totalDownloaded += candles.length;
      onProgress?.(totalDownloaded);

      cursor = candles[candles.length - 1][0] + tfMs;
      if (candles.length < BATCH_SIZE) break;
      await sleep(DELAY_MS);
    }
  }

  logger.info({ symbol, timeframe, totalDownloaded }, "Candle download complete");
}

/**
 * Load candles from the DB for a given symbol/timeframe/date range.
 * Returns them sorted by timestamp ascending as Candle tuples.
 */
export async function loadCandles(
  symbol: string,
  timeframe: string,
  startMs: number,
  endMs: number
): Promise<Candle[]> {
  const rows = await db
    .select()
    .from(historicalCandlesTable)
    .where(
      and(
        eq(historicalCandlesTable.symbol, symbol),
        eq(historicalCandlesTable.timeframe, timeframe),
        gte(historicalCandlesTable.timestamp, startMs),
        lte(historicalCandlesTable.timestamp, endMs)
      )
    )
    .orderBy(historicalCandlesTable.timestamp);

  return rows.map((r) => [
    Number(r.timestamp),
    Number(r.open),
    Number(r.high),
    Number(r.low),
    Number(r.close),
    Number(r.volume),
  ] as Candle);
}

/**
 * Get the count of candles already cached for a symbol/timeframe/range.
 */
export async function getCachedCandleCount(
  symbol: string,
  timeframe: string,
  startMs: number,
  endMs: number
): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(historicalCandlesTable)
    .where(
      and(
        eq(historicalCandlesTable.symbol, symbol),
        eq(historicalCandlesTable.timeframe, timeframe),
        gte(historicalCandlesTable.timestamp, startMs),
        lte(historicalCandlesTable.timestamp, endMs)
      )
    );
  return Number(rows[0]?.count ?? 0);
}
