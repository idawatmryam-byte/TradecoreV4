import type { MarketType } from "./brokers/brokerAdapter";
import type { ExecutionAuthority } from "./execution/authority";

export function executionClientIdentity(
  authority: ExecutionAuthority,
  marketType: MarketType,
): string {
  return `${authority}:${marketType}`;
}

export class MarketScopedCache<T> {
  private readonly values = new Map<"spot" | "futures", T>();

  getOrCreate(marketType: "spot" | "futures", create: () => T): T {
    const existing = this.values.get(marketType);
    if (existing !== undefined) return existing;
    const value = create();
    this.values.set(marketType, value);
    return value;
  }
}

function symbolBelongsToMarket(
  symbol: string,
  marketType: MarketType,
): boolean {
  if (marketType === "futures")
    return symbol.endsWith(":USDT") && symbol.includes("/");
  if (marketType === "spot")
    return symbol.includes("/") && !symbol.includes(":");
  return symbol.includes("_") && !symbol.includes("/") && !symbol.includes(":");
}

export function assertTickerSymbolsMatchMarket(
  symbols: readonly string[],
  marketType: MarketType,
): void {
  const invalid = symbols.filter(
    (symbol) => !symbolBelongsToMarket(symbol, marketType),
  );
  if (invalid.length > 0) {
    throw new Error(
      `Ticker request refused ${marketType}-foreign symbols: ${invalid.join(", ")}`,
    );
  }
}

interface TickerExchange {
  fetchTicker(symbol: string): Promise<unknown>;
  fetchTickers(symbols: string[]): Promise<Record<string, unknown>>;
}

export async function fetchTickersForMarket(input: {
  exchange: TickerExchange;
  marketType: MarketType;
  symbols: readonly string[];
  onSymbolError?: (symbol: string, error: unknown) => void;
}): Promise<Record<string, unknown>> {
  assertTickerSymbolsMatchMarket(input.symbols, input.marketType);
  if (input.marketType !== "futures") {
    return input.exchange.fetchTickers([...input.symbols]);
  }

  const results = await Promise.all(
    input.symbols.map(async (symbol) => {
      try {
        return [symbol, await input.exchange.fetchTicker(symbol)] as const;
      } catch (error) {
        input.onSymbolError?.(symbol, error);
        return [symbol, null] as const;
      }
    }),
  );
  return Object.fromEntries(results.filter((result) => result[1] !== null));
}
