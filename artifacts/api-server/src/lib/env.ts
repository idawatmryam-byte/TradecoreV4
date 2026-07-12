/**
 * TradeCore Pro — Environment validation  (Phase 5B, Production Hardening;
 * Multi-user Phase: per-user accounts + per-user Binance credentials)
 *
 * Previously, required env vars were each checked lazily, in whatever module
 * happened to read them first: `DATABASE_URL` at import time in
 * `@workspace/db`, `PORT` in `index.ts`. `validateEnv()` checks everything
 * the server needs up front, once, at startup, and throws a single clear
 * error listing every problem at once (not just the first one hit) if
 * anything is missing or malformed. Call this before `app.listen(...)` in
 * `index.ts`.
 *
 * Multi-user Phase: there is no longer a single shared operator credential
 * or a single global Binance API key/secret — each user registers their own
 * account (lib/passwordHash.ts) and supplies their own Binance credentials
 * via the settings page (encrypted at rest — see lib/credentialsCrypto.ts).
 * CREDENTIALS_ENCRYPTION_KEY is the one remaining server-side secret: it
 * protects every stored Binance credential, so it is validated here with
 * the same up-front rigor.
 */

export interface AppEnv {
  port: number;
  /** Bind address. `undefined` → Node's default (every interface), which is what
   *  Replit and any platform terminating TLS in front of us needs. Set to
   *  127.0.0.1 on a VPS where the dashboard is reached through an SSH tunnel or
   *  a local reverse proxy, so the port is never exposed on a public interface. */
  host: string | undefined;
  nodeEnv: "development" | "production" | "test";
  databaseUrl: string;
  /** HMAC signing key for the session cookie — see middleware/auth.ts. Never logged. */
  sessionSecret: string;
  /** AES-256-GCM key (32 raw bytes) encrypting every stored Binance credential — see lib/credentialsCrypto.ts. Never logged. */
  credentialsEncryptionKey: Buffer;
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

  const rawHost = process.env["HOST"];
  const host = isNonEmpty(rawHost) ? rawHost.trim() : undefined;

  const rawNodeEnv = process.env["NODE_ENV"];
  const nodeEnv = (isNonEmpty(rawNodeEnv) ? rawNodeEnv : "development") as AppEnv["nodeEnv"];
  if (!["development", "production", "test"].includes(nodeEnv)) {
    problems.push(`NODE_ENV="${rawNodeEnv}" must be one of development|production|test.`);
  }

  const databaseUrl = process.env["DATABASE_URL"];
  if (!isNonEmpty(databaseUrl)) {
    problems.push("DATABASE_URL is required (Postgres connection string).");
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

  const rawEncryptionKey = process.env["CREDENTIALS_ENCRYPTION_KEY"];
  let credentialsEncryptionKey: Buffer = Buffer.alloc(32);
  if (!isNonEmpty(rawEncryptionKey)) {
    problems.push(
      "CREDENTIALS_ENCRYPTION_KEY is required — protects every user's stored Binance API credentials. " +
        "Generate with: openssl rand -hex 32",
    );
  } else if (!/^[0-9a-fA-F]{64}$/.test(rawEncryptionKey)) {
    problems.push(
      "CREDENTIALS_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes) — generate with: openssl rand -hex 32",
    );
  } else {
    credentialsEncryptionKey = Buffer.from(rawEncryptionKey, "hex");
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
    host,
    nodeEnv,
    databaseUrl: databaseUrl!,
    sessionSecret: resolvedSessionSecret!,
    credentialsEncryptionKey,
    allowedOrigins,
  });

  return cached;
}

/** Test-only escape hatch — never call this from application code. */
export function _resetEnvCacheForTests(): void {
  cached = null;
}
