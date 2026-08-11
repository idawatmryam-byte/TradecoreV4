import type { MarketType } from "../brokers/brokerAdapter";
import type { Section } from "../engineRegistry";

export const EXECUTION_AUTHORITIES = [
  "legacy_unverified",
  "simulated_demo",
  "binance_spot_testnet",
  "binance_futures_demo",
  "oanda_practice",
  "binance_spot_live",
  "binance_futures_live",
  "oanda_live",
] as const;

export type ExecutionAuthority = (typeof EXECUTION_AUTHORITIES)[number];
export type VerifiedExecutionAuthority = Exclude<
  ExecutionAuthority,
  "legacy_unverified"
>;

export interface ExecutionAuthorityInput {
  section: Section;
  marketType: MarketType;
  executionTarget: "demo" | "live";
  testnet: boolean;
}

/**
 * Resolve the one authority that may handle a position. Section/market
 * mismatches are configuration corruption, not aliases, and fail closed.
 */
export function resolveExecutionAuthority(
  input: ExecutionAuthorityInput,
): VerifiedExecutionAuthority {
  if (input.section === "forex" && input.marketType !== "forex") {
    throw new Error(
      "Ambiguous execution authority: the forex section requires marketType=forex",
    );
  }
  if (input.section === "crypto" && input.marketType === "forex") {
    throw new Error(
      "Ambiguous execution authority: the crypto section cannot use marketType=forex",
    );
  }
  if (input.executionTarget === "demo") return "simulated_demo";
  if (input.marketType === "forex")
    return input.testnet ? "oanda_practice" : "oanda_live";
  if (input.marketType === "futures")
    return input.testnet ? "binance_futures_demo" : "binance_futures_live";
  return input.testnet ? "binance_spot_testnet" : "binance_spot_live";
}

export function parseExecutionAuthority(value: unknown): ExecutionAuthority {
  return typeof value === "string" &&
    (EXECUTION_AUTHORITIES as readonly string[]).includes(value)
    ? (value as ExecutionAuthority)
    : "legacy_unverified";
}

export function isSimulatedAuthority(
  authority: ExecutionAuthority,
): authority is "simulated_demo" {
  return authority === "simulated_demo";
}

export function isBrokerSandboxAuthority(
  authority: ExecutionAuthority,
): authority is
  | "binance_spot_testnet"
  | "binance_futures_demo"
  | "oanda_practice" {
  return (
    authority === "binance_spot_testnet" ||
    authority === "binance_futures_demo" ||
    authority === "oanda_practice"
  );
}

export function isBrokerAuthority(
  authority: ExecutionAuthority,
): authority is Exclude<VerifiedExecutionAuthority, "simulated_demo"> {
  return authority !== "legacy_unverified" && authority !== "simulated_demo";
}

export function providerForAuthority(
  authority: ExecutionAuthority,
): "binance" | "oanda" | "none" | "unknown" {
  if (authority === "simulated_demo") return "none";
  if (authority.startsWith("binance_")) return "binance";
  if (authority.startsWith("oanda_")) return "oanda";
  return "unknown";
}

export function marketTypeForAuthority(
  authority: ExecutionAuthority,
): MarketType | null {
  if (authority === "binance_spot_testnet" || authority === "binance_spot_live")
    return "spot";
  if (
    authority === "binance_futures_demo" ||
    authority === "binance_futures_live"
  )
    return "futures";
  if (authority === "oanda_practice" || authority === "oanda_live")
    return "forex";
  return null;
}

/**
 * Demo rows predate the authority column but are unambiguous: executionTarget
 * has always meant the local fill model. Broker-backed legacy rows are not
 * inferable from mutable config and remain unverified until an operator
 * reconciles and explicitly classifies them.
 */
export function authorityFromTrade(trade: {
  executionTarget: string | null;
  executionAuthority?: string | null;
}): ExecutionAuthority {
  const persisted = parseExecutionAuthority(trade.executionAuthority);
  if (persisted !== "legacy_unverified") return persisted;
  return trade.executionTarget === "demo"
    ? "simulated_demo"
    : "legacy_unverified";
}

export function assertAuthorityMatchesMarket(
  authority: ExecutionAuthority,
  marketType: MarketType,
): void {
  if (authority === "simulated_demo") return;
  const authorityMarket = marketTypeForAuthority(authority);
  if (authorityMarket === null || authorityMarket !== marketType) {
    throw new Error(
      `Ambiguous execution authority: ${authority} cannot manage marketType=${marketType}`,
    );
  }
}
