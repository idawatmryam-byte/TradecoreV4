import { binance as BinanceExchange, binanceusdm as BinanceUsdmExchange } from "ccxt";

export type BinanceMarketType = "spot" | "futures";

export interface BinanceClientOptions {
  apiKey: string;
  apiSecret: string;
  marketType: BinanceMarketType;
  testnet: boolean;
}

/**
 * Build the exact Binance client used by both engine startup and the
 * read-only connection check. Keeping endpoint selection here prevents the
 * two safety-critical paths from drifting (spot sandbox and futures Demo
 * Trading are different Binance environments with different credentials).
 */
export function buildBinanceClient(options: BinanceClientOptions): any {
  const ExchangeClass = options.marketType === "futures" ? BinanceUsdmExchange : BinanceExchange;
  const exchange = new ExchangeClass({
    apiKey: options.apiKey,
    secret: options.apiSecret,
    options: {
      defaultType: options.marketType,
      adjustForTimeDifference: true,
    },
  });

  if (options.testnet) {
    if (options.marketType === "futures") exchange.enableDemoTrading(true);
    else exchange.setSandboxMode(true);
  }

  return exchange;
}

export function binanceEnvironmentLabel(marketType: BinanceMarketType, testnet: boolean): string {
  if (!testnet) return marketType === "futures" ? "Binance USDⓈ-M Futures live" : "Binance Spot live";
  return marketType === "futures"
    ? "Binance Futures Demo Trading (demo-fapi.binance.com)"
    : "Binance Spot Testnet (testnet.binance.vision)";
}
