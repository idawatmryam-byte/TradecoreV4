import {
  AuthenticationError,
  ExchangeNotAvailable,
  InvalidNonce,
  NetworkError,
  PermissionDenied,
  RequestTimeout,
} from "ccxt";
import { buildBinanceClient, binanceEnvironmentLabel, type BinanceMarketType } from "./binanceClient";
import { OandaAdapter } from "./oandaAdapter";

export interface ConnectionTestResult {
  ok: true;
  provider: "binance" | "oanda";
  environment: string;
  marketType: "spot" | "futures" | "forex";
  accountAccessible: true;
  tradingEnabled: boolean | null;
  serverTimeOffsetMs: number | null;
  ipRestrictionEnabled: boolean | null;
  permissions: string[];
  warnings: string[];
  message: string;
}

export class ConnectionValidationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ConnectionValidationError";
  }
}

function binanceErrorCode(err: unknown): string | null {
  const infoCode = (err as { info?: { code?: unknown } })?.info?.code;
  if (typeof infoCode === "number" || typeof infoCode === "string") return String(infoCode);
  const message = err instanceof Error ? err.message : "";
  return message.match(/(?:code["': ]+)?(-\d{3,5})/)?.[1] ?? null;
}

/** Convert provider failures into stable, secret-free operator guidance. */
export function actionableConnectionError(provider: "binance" | "oanda", err: unknown): ConnectionValidationError {
  if (err instanceof ConnectionValidationError) return err;
  const errorName = typeof err === "object" && err !== null && "name" in err
    ? String((err as { name?: unknown }).name ?? "")
    : "";
  const errorMessage = err instanceof Error ? err.message : "";

  if (provider === "binance") {
    const code = binanceErrorCode(err);
    if (code === "-1021" || err instanceof InvalidNonce) {
      return new ConnectionValidationError(
        "CLOCK_OUT_OF_SYNC",
        "Binance rejected the timestamp. Synchronize the server clock with NTP, then test again.",
      );
    }
    if (code === "-2014") {
      return new ConnectionValidationError(
        "INVALID_KEY_FORMAT",
        "Binance rejected the API-key format. Copy the key and secret again without extra spaces.",
      );
    }
    if (code === "-2015" || err instanceof AuthenticationError || err instanceof PermissionDenied) {
      return new ConnectionValidationError(
        "AUTH_OR_IP_REJECTED",
        "Binance rejected the credentials. Confirm the key belongs to the selected Spot/Futures and Testnet/Live environment, trading is enabled, and this server IP is allowed by the key's whitelist.",
      );
    }
  } else {
    const accountOrEnvironmentRejected =
      err instanceof AuthenticationError ||
      err instanceof PermissionDenied ||
      /HTTP 40[04]|NO_SUCH_ACCOUNT|account.+(?:not found|does not exist|invalid)/i.test(errorMessage);
    if (accountOrEnvironmentRejected) {
      return new ConnectionValidationError(
        "AUTH_OR_ENVIRONMENT_REJECTED",
        "OANDA rejected the token or account. Confirm the account ID belongs to this token and that Practice/Live matches the selected environment.",
      );
    }
  }

  if (err instanceof RequestTimeout || errorName === "TimeoutError" || errorName === "AbortError") {
    return new ConnectionValidationError("PROVIDER_TIMEOUT", `${provider === "binance" ? "Binance" : "OANDA"} did not respond in time. Try again; if it persists, check outbound connectivity.`);
  }
  if (err instanceof ExchangeNotAvailable || err instanceof NetworkError || err instanceof TypeError) {
    return new ConnectionValidationError("PROVIDER_UNREACHABLE", `${provider === "binance" ? "Binance" : "OANDA"} is unreachable from this server. Check DNS, firewall, region restrictions, and provider status.`);
  }
  return new ConnectionValidationError(
    "CONNECTION_CHECK_FAILED",
    `${provider === "binance" ? "Binance" : "OANDA"} could not verify this connection. Check the selected environment and account permissions, then try again.`,
  );
}

export async function testBinanceConnection(input: {
  apiKey: string;
  apiSecret: string;
  marketType: BinanceMarketType;
  testnet: boolean;
}): Promise<ConnectionTestResult> {
  const exchange = buildBinanceClient(input);
  exchange.timeout = 15_000;
  const environment = binanceEnvironmentLabel(input.marketType, input.testnet);

  try {
    const before = Date.now();
    const serverTime = Number(await exchange.fetchTime());
    const after = Date.now();
    const serverTimeOffsetMs = serverTime - Math.round((before + after) / 2);
    if (Math.abs(serverTimeOffsetMs) > 5_000) {
      throw new ConnectionValidationError(
        "CLOCK_OUT_OF_SYNC",
        `The server clock differs from Binance by ${Math.abs(serverTimeOffsetMs)} ms. Synchronize it with NTP before trading.`,
      );
    }

    await exchange.loadMarkets();
    await exchange.fetchBalance();
    const account = input.marketType === "futures"
      ? await exchange.fapiPrivateGetAccount()
      : await exchange.privateGetAccount();
    const tradingEnabled = account?.canTrade !== false;
    if (!tradingEnabled) {
      throw new ConnectionValidationError(
        "TRADING_PERMISSION_MISSING",
        `The key can read the ${input.marketType} account but Binance reports trading disabled. Enable ${input.marketType === "futures" ? "Futures" : "Spot"} trading; withdrawal permission is not needed.`,
      );
    }

    const permissions = ["account-read", `${input.marketType}-trade`];
    const warnings: string[] = [];
    let ipRestrictionEnabled: boolean | null = null;

    // Binance exposes key-level IP and product permissions on live SAPI. That
    // endpoint is unavailable on Spot Testnet/Futures Demo, so absence there
    // is reported as unsupported rather than guessed or treated as failure.
    if (!input.testnet) {
      try {
        const restrictions = await exchange.sapiGetAccountApiRestrictions();
        ipRestrictionEnabled = typeof restrictions?.ipRestrict === "boolean" ? restrictions.ipRestrict : null;
        const productEnabled = input.marketType === "futures"
          ? restrictions?.enableFutures !== false
          : restrictions?.enableSpotAndMarginTrading !== false;
        if (!productEnabled) {
          throw new ConnectionValidationError(
            "TRADING_PERMISSION_MISSING",
            `Binance reports that ${input.marketType === "futures" ? "Futures" : "Spot"} trading is not enabled for this key. Withdrawal permission is not required.`,
          );
        }
      } catch (err) {
        if (err instanceof ConnectionValidationError) throw err;
        warnings.push("Binance authenticated the account, but did not expose key-level IP restrictions through this endpoint.");
      }
    } else {
      warnings.push("This Binance test environment does not expose key-level IP-whitelist diagnostics.");
    }

    if (Math.abs(serverTimeOffsetMs) > 1_000) {
      warnings.push(`Server clock is ${Math.abs(serverTimeOffsetMs)} ms from Binance; NTP synchronization is recommended.`);
    }

    return {
      ok: true,
      provider: "binance",
      environment,
      marketType: input.marketType,
      accountAccessible: true,
      tradingEnabled: true,
      serverTimeOffsetMs,
      ipRestrictionEnabled,
      permissions,
      warnings,
      message: `${environment} connection verified. Account access and ${input.marketType} trading permission are available; withdrawal permission was not requested.`,
    };
  } catch (err) {
    throw actionableConnectionError("binance", err);
  }
}

export async function testOandaConnection(input: {
  token: string;
  accountId: string;
  practice: boolean;
}): Promise<ConnectionTestResult> {
  const environment = input.practice ? "OANDA Practice (api-fxpractice.oanda.com)" : "OANDA Live (api-fxtrade.oanda.com)";
  try {
    const adapter = new OandaAdapter(input);
    const markets = await adapter.loadMarkets();
    await adapter.fetchBalance();
    if (Object.keys(markets).length === 0) {
      throw new ConnectionValidationError(
        "NO_TRADABLE_INSTRUMENTS",
        "OANDA authenticated the account but returned no accessible instruments. Confirm this is a v20 trading account.",
      );
    }

    return {
      ok: true,
      provider: "oanda",
      environment,
      marketType: "forex",
      accountAccessible: true,
      // OANDA v20 does not expose a safe, non-mutating endpoint that proves
      // order permission independently of account/instrument access.
      tradingEnabled: null,
      serverTimeOffsetMs: null,
      ipRestrictionEnabled: null,
      permissions: ["account-read", "market-data"],
      warnings: ["OANDA does not expose a non-mutating trade-permission or IP-whitelist probe; no order was placed during this check."],
      message: `${environment} connection verified. The token can access the account and its tradable instruments; no order was placed.`,
    };
  } catch (err) {
    throw actionableConnectionError("oanda", err);
  }
}
