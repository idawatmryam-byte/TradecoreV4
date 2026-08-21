import type {
  BrokerBalance,
  BrokerTicker,
  MarketType,
} from "../brokers/brokerAdapter";

export type AuthoritativeEquity =
  | {
      state: "AVAILABLE";
      currentEquityMinor: bigint;
      sourceIdentity: string;
      observedAt: Date;
      freshUntil: Date;
    }
  | { state: "UNKNOWN"; reasonCode: string; reason: string };

interface DecimalValue {
  coefficient: bigint;
  scale: number;
}

function parseDecimal(value: unknown): DecimalValue | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  const text = String(value).trim();
  if (text.length > 128) return null;
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match) return null;
  const negative = match[1] === "-";
  const fractional = match[3] ?? "";
  const exponent = Number(match[4] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 60) return null;
  let coefficient = BigInt(`${match[2]}${fractional}`);
  let scale = fractional.length - exponent;
  if (scale < 0) {
    coefficient *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { coefficient: negative ? -coefficient : coefficient, scale };
}

function pow10(scale: number): bigint {
  return 10n ** BigInt(scale);
}

/** Exact, conservative conversion of a provider decimal into integer cents. */
export function decimalToMinor(value: unknown): bigint | null {
  const parsed = parseDecimal(value);
  if (!parsed || parsed.coefficient < 0n) return null;
  return (parsed.coefficient * 100n) / pow10(parsed.scale);
}

function productToMinor(left: unknown, right: unknown): bigint | null {
  const a = parseDecimal(left);
  const b = parseDecimal(right);
  if (!a || !b || a.coefficient < 0n || b.coefficient < 0n) return null;
  return (a.coefficient * b.coefficient * 100n) / pow10(a.scale + b.scale);
}

function positive(value: unknown): boolean {
  const parsed = parseDecimal(value);
  return parsed !== null && parsed.coefficient > 0n;
}

/**
 * Convert provider-owned account truth into exact persisted minor units.
 * Spot equity is marked from every positive broker balance at a fresh bid;
 * an unpriced asset makes the whole result UNKNOWN instead of silently zero.
 */
export function deriveAuthoritativeEquity(input: {
  marketType: MarketType;
  balance: BrokerBalance;
  tickers?: Record<string, BrokerTicker>;
  observedAt: Date;
  maxAgeMs: number;
}): AuthoritativeEquity {
  if (
    !Number.isInteger(input.maxAgeMs) ||
    input.maxAgeMs < 1 ||
    !Number.isFinite(input.observedAt.getTime())
  ) {
    return {
      state: "UNKNOWN",
      reasonCode: "EQUITY_FRESHNESS_INVALID",
      reason: "Equity freshness policy or observation time is invalid",
    };
  }
  const freshUntil = new Date(input.observedAt.getTime() + input.maxAgeMs);
  if (input.marketType === "forex") {
    const info = input.balance.info as
      | {
          NAV?: unknown;
          homeCurrency?: unknown;
          homeToUsdRate?: unknown;
        }
      | undefined;
    const homeCurrency =
      typeof info?.homeCurrency === "string"
        ? info.homeCurrency.toUpperCase()
        : null;
    const minor =
      homeCurrency === "USD"
        ? decimalToMinor(info?.NAV)
        : homeCurrency !== null &&
            info?.NAV !== undefined &&
            info.homeToUsdRate !== undefined
          ? productToMinor(info.NAV, info.homeToUsdRate)
          : null;
    return minor !== null && minor > 0n
      ? {
          state: "AVAILABLE",
          currentEquityMinor: minor,
          sourceIdentity:
            homeCurrency === "USD"
              ? "OANDA_NAV_USD"
              : `OANDA_NAV_${homeCurrency ?? "UNKNOWN"}_TO_USD`,
          observedAt: input.observedAt,
          freshUntil,
        }
      : {
          state: "UNKNOWN",
          reasonCode: "OANDA_NAV_UNAVAILABLE",
          reason:
            "OANDA raw NAV or its authoritative home-currency conversion is unavailable or invalid",
        };
  }
  if (input.marketType === "futures") {
    const info = input.balance.info as
      | { totalMarginBalance?: unknown }
      | undefined;
    const minor = decimalToMinor(info?.totalMarginBalance);
    return minor !== null && minor > 0n
      ? {
          state: "AVAILABLE",
          currentEquityMinor: minor,
          sourceIdentity: "BINANCE_FUTURES_TOTAL_MARGIN_BALANCE",
          observedAt: input.observedAt,
          freshUntil,
        }
      : {
          state: "UNKNOWN",
          reasonCode: "BINANCE_FUTURES_EQUITY_UNAVAILABLE",
          reason:
            "Binance futures total margin balance is unavailable or invalid",
        };
  }

  const totals = input.balance.total;
  const tickers = input.tickers;
  if (!totals || !tickers) {
    return {
      state: "UNKNOWN",
      reasonCode: "BINANCE_SPOT_EQUITY_INPUT_UNAVAILABLE",
      reason: "Spot balances or provider tickers are unavailable",
    };
  }
  let totalMinor = 0n;
  let assets = 0;
  for (const [asset, quantity] of Object.entries(totals)) {
    if (!positive(quantity)) continue;
    assets += 1;
    if (asset === "USDT") {
      const minor = decimalToMinor(quantity);
      if (minor === null) {
        return {
          state: "UNKNOWN",
          reasonCode: "BINANCE_SPOT_BALANCE_INVALID",
          reason: "USDT balance is invalid",
        };
      }
      totalMinor += minor;
      continue;
    }
    const ticker = tickers[`${asset}/USDT`];
    const price = ticker?.bid;
    const ageMs = ticker ? input.observedAt.getTime() - ticker.timestamp : NaN;
    if (
      !ticker ||
      !positive(price) ||
      !Number.isFinite(ageMs) ||
      ageMs < 0 ||
      ageMs > input.maxAgeMs
    ) {
      return {
        state: "UNKNOWN",
        reasonCode: "BINANCE_SPOT_ASSET_PRICE_UNAVAILABLE",
        reason: `Positive ${asset} balance lacks a fresh authoritative USDT bid`,
      };
    }
    const minor = productToMinor(quantity, price);
    if (minor === null) {
      return {
        state: "UNKNOWN",
        reasonCode: "BINANCE_SPOT_ASSET_VALUE_INVALID",
        reason: `Positive ${asset} balance cannot be valued exactly`,
      };
    }
    totalMinor += minor;
  }
  if (assets === 0 || totalMinor <= 0n) {
    return {
      state: "UNKNOWN",
      reasonCode: "BINANCE_SPOT_EQUITY_UNAVAILABLE",
      reason: "No positive authoritative spot account equity is available",
    };
  }
  return {
    state: "AVAILABLE",
    currentEquityMinor: totalMinor,
    sourceIdentity: "BINANCE_SPOT_MARKED_BALANCES",
    observedAt: input.observedAt,
    freshUntil,
  };
}
