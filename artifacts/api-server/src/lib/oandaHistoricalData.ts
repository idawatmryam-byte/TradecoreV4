/**
 * TradeCore Pro — OANDA Historical Candle Downloader (forex backtesting)
 *
 * The forex counterpart of historicalData.ts: fetches mid-price OHLCV from
 * OANDA's v20 candles endpoint into the SAME historical_candles cache the
 * backtest engine reads from. No name collisions are possible — OANDA
 * instruments carry an underscore ("EUR_USD") that no Binance symbol has.
 *
 * Differences from the Binance downloader that matter:
 *
 *  - AUTH: OANDA's candle endpoint requires a token (there is no public
 *    market-data API), so downloads run with the requesting user's stored
 *    OANDA credentials — same practice/live base URL selection as the
 *    live engine (botConfig.testnet on the forex section row).
 *  - MARKET HOURS: forex closes on weekends, so a naive candles-per-
 *    millisecond coverage estimate would flag every cached week as "full
 *    of gaps" (~5/7 ≈ 71% < the 90% re-download threshold) and re-fetch
 *    the world on every run. Expected counts here are scaled by the OPEN
 *    fraction of the requested range, computed from the same marketHours
 *    predicate the live engine trades by.
 *  - PAGING: OANDA caps candles per response at 5000 and errors when a
 *    from/to range would exceed it — so paging uses from+count and walks
 *    forward until past the requested end.
 *  - "3m" has no native granularity (no M3): M1 is downloaded and
 *    aggregated 3×, exactly like the live adapter's synthesis.
 */
import { db } from "@workspace/db";
import { historicalCandlesTable, botConfigTable } from "@workspace/db";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { OandaClient, oandaTimeToMs } from "./brokers/oandaClient";
import { aggregateCandles } from "./brokers/oandaAdapter";
import { getOandaCredentials } from "./oandaCredentials";
import { isInstrumentOpen } from "./marketHours";
import { logger } from "./logger";
import type { Candle } from "./historicalData";

const MAX_COUNT = 5000; // OANDA per-request candle cap
const DELAY_MS = 150;   // polite spacing between paged requests

/** Engine timeframe → native OANDA granularity ("3m" handled by synthesis). */
const GRANULARITY: Record<string, string> = {
  "1m": "M1", "5m": "M5", "15m": "M15", "30m": "M30",
  "1h": "H1", "4h": "H4", "1d": "D",
};

const TF_MS: Record<string, number> = {
  "1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000,
  "30m": 1_800_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000,
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Client from the user's stored credentials + their forex practice/live flag. */
async function clientForUser(userId: number): Promise<OandaClient> {
  const creds = await getOandaCredentials(userId);
  if (!creds) {
    throw new Error(
      "No OANDA credentials configured — connect an OANDA account in Account & Safety to backtest forex instruments.",
    );
  }
  const [cfg] = await db
    .select({ testnet: botConfigTable.testnet })
    .from(botConfigTable)
    .where(and(eq(botConfigTable.userId, userId), eq(botConfigTable.section, "forex")));
  return new OandaClient({ token: creds.token, accountId: creds.accountId, practice: cfg?.testnet ?? true });
}

/**
 * Fraction of [startMs, endMs] during which the currency market is open —
 * sampled at 30-minute resolution (boundaries are on the hour, so this is
 * exact for any range longer than a day). Used to scale expected candle
 * counts so weekend gaps don't read as missing data.
 */
export function openFraction(startMs: number, endMs: number): number {
  const step = 30 * 60_000;
  let open = 0;
  let total = 0;
  for (let t = startMs; t < endMs; t += step) {
    total++;
    if (isInstrumentOpen("CURRENCY", new Date(t))) open++;
  }
  return total === 0 ? 1 : open / total;
}

interface OandaRawCandle {
  time: string;
  mid: { o: string; h: string; l: string; c: string };
  volume: number;
  complete: boolean;
}

/** Page through OANDA candles from `fromMs` until past `toMs` (complete only). */
async function fetchRange(
  client: OandaClient,
  instrument: string,
  granularity: string,
  tfMs: number,
  fromMs: number,
  toMs: number,
): Promise<Candle[]> {
  const out: Candle[] = [];
  let cursor = fromMs;
  // Bounded loop: each page advances the cursor by ≥1 candle or breaks.
  for (let page = 0; page < 500; page++) {
    const from = (cursor / 1000).toFixed(0);
    const res = await client.request<{ candles: OandaRawCandle[] }>(
      "GET",
      `/v3/instruments/${instrument}/candles?granularity=${granularity}&from=${from}&count=${MAX_COUNT}&price=M`,
    );
    const batch = res.candles.filter((c) => c.complete);
    if (batch.length === 0) break;
    for (const c of batch) {
      const ts = oandaTimeToMs(c.time);
      if (ts > toMs) break;
      out.push([ts, Number(c.mid.o), Number(c.mid.h), Number(c.mid.l), Number(c.mid.c), c.volume]);
    }
    const lastTs = oandaTimeToMs(batch[batch.length - 1]!.time);
    if (lastTs >= toMs || batch.length < MAX_COUNT) break;
    cursor = lastTs + tfMs;
    await sleep(DELAY_MS);
  }
  return out;
}

async function persist(symbol: string, timeframe: string, candles: Candle[]): Promise<void> {
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
  for (let i = 0; i < rows.length; i += 500) {
    await db.insert(historicalCandlesTable).values(rows.slice(i, i + 500)).onConflictDoNothing();
  }
}

/**
 * Ensure OANDA candles for [startMs, endMs] are cached, downloading whatever
 * is missing with the user's stored credentials. Mirrors ensureCandles()'s
 * contract so the backtest engine can call either interchangeably.
 */
export async function ensureForexCandles(
  userId: number,
  symbol: string,
  timeframe: string,
  startMs: number,
  endMs: number,
): Promise<void> {
  const tfMs = TF_MS[timeframe];
  if (!tfMs) throw new Error(`Unsupported timeframe: ${timeframe}`);

  // Cached coverage, scaled by market-open time (see module header).
  const [cachedRow] = await db
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
        lte(historicalCandlesTable.timestamp, endMs),
      ),
    );
  const cachedCount = Number(cachedRow?.count ?? 0);
  const expected = Math.max(1, Math.floor(((endMs - startMs) / tfMs) * openFraction(startMs, endMs)));
  if (cachedCount / expected >= 0.9) {
    logger.info({ symbol, timeframe, cachedCount, expected }, "Forex candles already cached, skipping download");
    return;
  }

  const client = await clientForUser(userId);

  if (timeframe === "3m") {
    // No M3 on OANDA — ensure the M1 base range, then aggregate and persist.
    await ensureForexCandles(userId, symbol, "1m", startMs, endMs);
    const m1 = await db
      .select()
      .from(historicalCandlesTable)
      .where(
        and(
          eq(historicalCandlesTable.symbol, symbol),
          eq(historicalCandlesTable.timeframe, "1m"),
          gte(historicalCandlesTable.timestamp, startMs),
          lte(historicalCandlesTable.timestamp, endMs),
        ),
      )
      .orderBy(historicalCandlesTable.timestamp);
    const m1Candles: Candle[] = m1.map((r) => [
      Number(r.timestamp), Number(r.open), Number(r.high), Number(r.low), Number(r.close), Number(r.volume),
    ]);
    await persist(symbol, "3m", aggregateCandles(m1Candles, 3 * 60_000) as Candle[]);
    return;
  }

  const gran = GRANULARITY[timeframe];
  if (!gran) throw new Error(`OANDA has no granularity for timeframe ${timeframe}`);

  logger.info(
    { symbol, timeframe, from: new Date(startMs).toISOString(), to: new Date(endMs).toISOString(), cachedCount, expected },
    "Downloading OANDA candles",
  );
  const candles = await fetchRange(client, symbol, gran, tfMs, startMs, endMs);
  await persist(symbol, timeframe, candles);
  logger.info({ symbol, timeframe, downloaded: candles.length }, "OANDA candle download complete");
}
