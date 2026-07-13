/**
 * TradeCore Pro — DB-symbol ⟷ ccxt-unified-symbol mapping
 *
 * ROOT CAUSE THIS FIXES: the engine stored/configured plain Binance symbols
 * ("BTCUSDT") and converted them to ccxt unified symbols with a hardcoded
 * `replace(/USDT$/, "/USDT")` — which is the SPOT format only. ccxt keys
 * USDⓈ-M perpetuals as "BTC/USDT:USDT" (settle-currency suffix), so in
 * futures mode every configured pair failed the `availableMarkets.has(...)`
 * check and the engine silently monitored/scanned ZERO pairs: no tickers, no
 * decisions, no trades, no errors — for hours. (Seen live: "723 markets"
 * loaded with "Scanning 0 pairs".) The reverse conversion was equally broken
 * for futures: "BTC/USDT:USDT".replace("/","") → "BTCUSDT:USDT", corrupting
 * DB symbols in reconciliation paths.
 *
 * THE PROPER FIX: don't guess with string surgery — ask the exchange. ccxt's
 * `market.id` is Binance's raw id ("BTCUSDT"), identical to what we store in
 * the DB, for BOTH spot and USDⓈ-M perpetuals. Build an exact two-way map
 * from loadMarkets() output. Dated/quarterly futures have distinct raw ids
 * ("BTCUSDT_240628") so they can never collide with, or be mistaken for, the
 * perpetual.
 *
 * Pure and exchange-free so it is unit-testable offline — see
 * harness/market-symbols.test.ts.
 */

export interface SymbolMarketMaps {
  /** "BTCUSDT" → ccxt unified symbol ("BTC/USDT" spot, "BTC/USDT:USDT" futures). */
  toUnified: Map<string, string>;
  /** ccxt unified symbol → "BTCUSDT" (exact reverse of toUnified). */
  toPlain: Map<string, string>;
}

/** Minimal shape of a ccxt market entry that this module relies on. */
interface CcxtMarketLike {
  id?: string | number;
  symbol?: string;
  active?: boolean;
  /** true for perpetual swaps (ccxt sets this on binanceusdm contracts). */
  swap?: boolean;
}

/**
 * Build the two-way symbol maps from `exchange.markets` (the object
 * loadMarkets() populates). Inactive markets are skipped; when two markets
 * share a raw id (defensive — shouldn't happen per exchange class), a
 * perpetual swap wins over anything else so the engine never trades a dated
 * contract by accident.
 */
export function buildSymbolMarketMaps(markets: Record<string, unknown>): SymbolMarketMaps {
  const toUnified = new Map<string, string>();
  const toPlain = new Map<string, string>();
  const chosen = new Map<string, CcxtMarketLike>();

  for (const raw of Object.values(markets)) {
    const m = raw as CcxtMarketLike;
    if (!m || typeof m.symbol !== "string" || m.id == null) continue;
    if (m.active === false) continue;
    const id = String(m.id);

    const existing = chosen.get(id);
    // Prefer a perpetual swap over any other market type sharing the id.
    if (existing && existing.swap === true && m.swap !== true) continue;
    chosen.set(id, m);
  }

  for (const [id, m] of chosen) {
    toUnified.set(id, m.symbol!);
    toPlain.set(m.symbol!, id);
  }

  return { toUnified, toPlain };
}

/**
 * Fallback conversions for when the maps aren't available (markets not
 * loaded yet) or a symbol isn't in them. These implement the format rules
 * directly; the maps are always preferred because they're exact.
 */
export function unifiedFromPlainFallback(symbol: string, marketType: "spot" | "futures"): string {
  const spotStyle = symbol.replace(/USDT$/, "/USDT");
  return marketType === "futures" ? `${spotStyle}:USDT` : spotStyle;
}

export function plainFromUnifiedFallback(unified: string): string {
  // "BTC/USDT:USDT" → "BTC/USDT" → "BTCUSDT"; spot input is unaffected.
  return unified.split(":")[0]!.replace("/", "");
}
