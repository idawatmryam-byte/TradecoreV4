/**
 * TradeCore Pro — Environment validation  (Phase 5B, Production Hardening)
 *
 * Previously, required env vars were each checked lazily, in whatever module
 * happened to read them first: `DATABASE_URL` at import time in
 * `@workspace/db`, `PORT` in `index.ts`, and — worst of all —
 * `BINANCE_API_KEY`/`BINANCE_API_SECRET` only inside `botEngine.initExchange()`,
 * meaning the HTTP server would boot and start serving requests completely
 * successfully even with no exchange credentials configured at all, and the
 * misconfiguration would only surface later when someone tried to actually
 * start the bot — in production, potentially hours or days after deploy.
 *
 * `validateEnv()` checks everything the server needs up front, once, at
 * startup, and throws a single clear error listing every problem at once
 * (not just the first one hit) if anything is missing or malformed. Call
 * this before `app.listen(...)` in `index.ts`.
 */

export interface AppEnv {
  port: number;
  nodeEnv: "development" | "production" | "test";
  databaseUrl: string;
  binanceApiKey: string;
  binanceApiSecret: string;
  /** Shared operator credentials — see middleware/auth.ts. Never logged. */
  operatorUsername: string;
  operatorPassword: string;
  /** HMAC signing key for the session cookie — see middleware/auth.ts. Never logged. */
  sessionSecret: string;
  /** Comma-separated allow-list of origins permitted to make cross-origin API
   *  calls. Empty = no cross-origin calls allowed (same-origin only), which
   *  is the safe default — this app serves its own frontend, so cross-origin
   *  access is only needed for a separate dev-server origin or an external
   *  integration you explicitly intend to allow. */
  allowedOrigins: string[];
}

class EnvValidationError extends Error {
  constructor(problems: string[]) {
    super(
      `Environment validation failed — refusing to start:\n` +
        problems.map((p) => `  ✗ ${p}`).join("\n") +
        `\n\nSet the missing/invalid variables and restart. See .env.example.`,
    );
    this.name = "EnvValidationError";
  }
}

function isNonEmpty(v: string | undefined): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

let cached: AppEnv | null = null;

/**
 * Validate all required environment variables and return a typed, frozen
 * snapshot. Throws `EnvValidationError` (listing every problem found, not
 * just the first) if anything required is missing or malformed. Memoized —
 * safe to call from multiple modules; the process env is only read once.
 */
export function validateEnv(): AppEnv {
  if (cached) return cached;

  const problems: string[] = [];

  const rawPort = process.env["PORT"];
  let port = 0;
  if (!isNonEmpty(rawPort)) {
    problems.push("PORT is required (e.g. 8080).");
  } else {
    port = Number(rawPort);
    if (Number.isNaN(port) || port <= 0 || port > 65535) {
      problems.push(`PORT="${rawPort}" is not a valid port number.`);
    }
  }

  const rawNodeEnv = process.env["NODE_ENV"];
  const nodeEnv = (isNonEmpty(rawNodeEnv) ? rawNodeEnv : "development") as AppEnv["nodeEnv"];
  if (!["development", "production", "test"].includes(nodeEnv)) {
    problems.push(`NODE_ENV="${rawNodeEnv}" must be one of development|production|test.`);
  }

  const databaseUrl = process.env["DATABASE_URL"];
  if (!isNonEmpty(databaseUrl)) {
    problems.push("DATABASE_URL is required (Postgres connection string).");
  }

  const binanceApiKey = process.env["BINANCE_API_KEY"];
  if (!isNonEmpty(binanceApiKey)) {
    problems.push("BINANCE_API_KEY is required (validated here even though the bot only connects lazily — so a missing key is caught at deploy time, not when someone finally clicks Start).");
  }

  const binanceApiSecret = process.env["BINANCE_API_SECRET"];
  if (!isNonEmpty(binanceApiSecret)) {
    problems.push("BINANCE_API_SECRET is required.");
  }

  const operatorUsername = process.env["OPERATOR_USERNAME"];
  if (!isNonEmpty(operatorUsername)) {
    problems.push("OPERATOR_USERNAME is required — this protects every trading/config endpoint.");
  }

  const operatorPassword = process.env["OPERATOR_PASSWORD"];
  if (!isNonEmpty(operatorPassword)) {
    problems.push("OPERATOR_PASSWORD is required — this protects every trading/config endpoint.");
  } else if (operatorPassword.length < 12) {
    problems.push("OPERATOR_PASSWORD is too short (< 12 chars) — use a long, unique passphrase.");
  }

  const sessionSecret = process.env["SESSION_SECRET"];
  let resolvedSessionSecret = sessionSecret;
  if (!isNonEmpty(sessionSecret)) {
    if (nodeEnv === "production") {
      problems.push(
        "SESSION_SECRET is required in production — generate with: openssl rand -hex 32",
      );
    } else {
      // Dev convenience only: never do this in production (enforced above).
      resolvedSessionSecret = "dev-only-insecure-session-secret-do-not-use-in-production";
    }
  } else if (sessionSecret.length < 16) {
    problems.push("SESSION_SECRET is too short (< 16 chars) — generate with: openssl rand -hex 32");
  }

  const rawAllowedOrigins = process.env["ALLOWED_ORIGINS"];
  const allowedOrigins = isNonEmpty(rawAllowedOrigins)
    ? rawAllowedOrigins.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  if (problems.length > 0) {
    throw new EnvValidationError(problems);
  }

  cached = Object.freeze({
    port,
    nodeEnv,
    databaseUrl: databaseUrl!,
    binanceApiKey: binanceApiKey!,
    binanceApiSecret: binanceApiSecret!,
    operatorUsername: operatorUsername!,
    operatorPassword: operatorPassword!,
    sessionSecret: resolvedSessionSecret!,
    allowedOrigins,
  });

  return cached;
}

/** Test-only escape hatch — never call this from application code. */
export function _resetEnvCacheForTests(): void {
  cached = null;
}
