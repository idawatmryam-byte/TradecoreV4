/**
 * TradeCore Pro — low-level OANDA v20 REST client
 *
 * One tiny fetch wrapper shared by everything OANDA. Practice vs live is
 * ONLY a base-URL difference (each environment accepts its own tokens):
 *
 *   practice → https://api-fxpractice.oanda.com
 *   live     → https://api-fxtrade.oanda.com
 *
 * `Accept-Datetime-Format: UNIX` makes every timestamp an epoch-seconds
 * string ("1657234800.000000000") — parse with parseFloat and ×1000 for ms.
 *
 * Error mapping: 401/403 throw ccxt's real `AuthenticationError` so the
 * engine's start-time `instanceof AuthenticationError` classification
 * (botEngine.ts) works identically for both brokers; everything else throws
 * a plain Error carrying the HTTP status and OANDA's `errorMessage`.
 */
import { AuthenticationError } from "ccxt";

export interface OandaClientConfig {
  token: string;
  accountId: string;
  /** true → fxpractice (paper), false → fxtrade (live money). */
  practice: boolean;
}

const PRACTICE_BASE = "https://api-fxpractice.oanda.com";
const LIVE_BASE = "https://api-fxtrade.oanda.com";

export class OandaClient {
  readonly accountId: string;
  private readonly token: string;
  private readonly baseUrl: string;

  constructor(config: OandaClientConfig) {
    this.token = config.token;
    this.accountId = config.accountId;
    this.baseUrl = config.practice ? PRACTICE_BASE : LIVE_BASE;
  }

  /** GET/PUT/POST a v20 path ("/v3/accounts/…"); returns the parsed JSON body. */
  async request<T = any>(
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "Accept-Datetime-Format": "UNIX",
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });

    if (!res.ok) {
      let detail = "";
      try {
        const errBody = (await res.json()) as { errorMessage?: string };
        detail = errBody?.errorMessage ?? "";
      } catch {
        /* non-JSON error body — status alone will have to do */
      }
      const msg = `OANDA ${method} ${path} failed: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`;
      if (res.status === 401 || res.status === 403) {
        // Real ccxt class on purpose — see module header.
        throw new AuthenticationError(msg);
      }
      throw new Error(msg);
    }

    return (await res.json()) as T;
  }

  /** Shorthand for account-scoped paths: acct("/summary") → /v3/accounts/{id}/summary */
  acct<T = any>(method: "GET" | "POST" | "PUT", subPath: string, body?: unknown): Promise<T> {
    return this.request<T>(method, `/v3/accounts/${this.accountId}${subPath}`, body);
  }
}

/** OANDA UNIX time string ("1657234800.000000000") → epoch milliseconds. */
export function oandaTimeToMs(t: string): number {
  return Math.round(parseFloat(t) * 1000);
}
