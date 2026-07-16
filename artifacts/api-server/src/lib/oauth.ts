/**
 * TradeCore Pro — Social sign-in (Google / Apple), no extra dependencies.
 *
 * Server-side authorization-code flow for both providers. Each is OPTIONAL:
 * a provider activates only when its env vars are set, and the frontend asks
 * GET /auth/providers which buttons to show — an unconfigured provider simply
 * doesn't appear. Setup:
 *
 *   Google (free — Google Cloud Console → APIs & Services → Credentials):
 *     GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET
 *     Authorized redirect URI:  <PUBLIC_URL>/api/auth/google/callback
 *
 *   Apple (requires Apple Developer Program membership):
 *     APPLE_OAUTH_CLIENT_ID  (the Services ID, e.g. com.example.tradecore.web)
 *     APPLE_OAUTH_TEAM_ID, APPLE_OAUTH_KEY_ID,
 *     APPLE_OAUTH_PRIVATE_KEY (the .p8 key PEM; newlines may be \n-escaped)
 *     Return URL:  <PUBLIC_URL>/api/auth/apple/callback
 *
 *   Both need PUBLIC_URL (the site origin users hit, e.g. https://host:8443).
 *
 * TRUST MODEL: we exchange the authorization code directly with the provider
 * over TLS, so the id_token in the response comes from the provider itself —
 * decoding its payload (without local JWKS signature verification) is sound
 * here. That shortcut would NOT be safe for tokens received from a browser.
 * Identity is keyed on the token's stable `sub` claim, never on email
 * (providers let users change email; `sub` never changes).
 */
import { createSign } from "node:crypto";
import { logger } from "./logger";

export interface OAuthIdentity {
  provider: "google" | "apple";
  /** The provider's stable subject id — the identity key. */
  providerUserId: string;
  email: string | null;
  displayName: string | null;
}

const env = (k: string): string | undefined => {
  const v = process.env[k]?.trim();
  return v ? v : undefined;
};

export function publicUrl(): string | undefined {
  return env("PUBLIC_URL")?.replace(/\/+$/, "");
}

export function googleEnabled(): boolean {
  return !!(env("GOOGLE_OAUTH_CLIENT_ID") && env("GOOGLE_OAUTH_CLIENT_SECRET") && publicUrl());
}

export function appleEnabled(): boolean {
  return !!(
    env("APPLE_OAUTH_CLIENT_ID") && env("APPLE_OAUTH_TEAM_ID") &&
    env("APPLE_OAUTH_KEY_ID") && env("APPLE_OAUTH_PRIVATE_KEY") && publicUrl()
  );
}

function b64urlJson(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

/** Decode a JWT's payload WITHOUT signature verification — only ever call
 *  this on tokens received directly from the provider's token endpoint. */
function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const part = jwt.split(".")[1];
  if (!part) throw new Error("malformed JWT");
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

// ─────────────────────────────────────────────────────────────────────────────
// Google
// ─────────────────────────────────────────────────────────────────────────────

export function googleAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: env("GOOGLE_OAUTH_CLIENT_ID")!,
    redirect_uri: `${publicUrl()}/api/auth/google/callback`,
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function exchangeGoogleCode(code: string): Promise<OAuthIdentity> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env("GOOGLE_OAUTH_CLIENT_ID")!,
      client_secret: env("GOOGLE_OAUTH_CLIENT_SECRET")!,
      redirect_uri: `${publicUrl()}/api/auth/google/callback`,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) {
    logger.warn({ status: res.status, body: await res.text().catch(() => "") }, "Google token exchange failed");
    throw new Error("Google token exchange failed");
  }
  const data = (await res.json()) as { id_token?: string };
  if (!data.id_token) throw new Error("Google response missing id_token");
  const claims = decodeJwtPayload(data.id_token);
  const sub = String(claims.sub ?? "");
  if (!sub) throw new Error("Google id_token missing sub");
  return {
    provider: "google",
    providerUserId: sub,
    email: typeof claims.email === "string" ? claims.email : null,
    displayName: typeof claims.name === "string" ? claims.name : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Apple
// ─────────────────────────────────────────────────────────────────────────────

/** Apple has no static client secret — it's a short-lived ES256 JWT signed
 *  with the developer's .p8 key. */
function appleClientSecret(): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlJson({ alg: "ES256", kid: env("APPLE_OAUTH_KEY_ID") });
  const payload = b64urlJson({
    iss: env("APPLE_OAUTH_TEAM_ID"),
    iat: now,
    exp: now + 300,
    aud: "https://appleid.apple.com",
    sub: env("APPLE_OAUTH_CLIENT_ID"),
  });
  const signingInput = `${header}.${payload}`;
  const key = env("APPLE_OAUTH_PRIVATE_KEY")!.replace(/\\n/g, "\n");
  const signer = createSign("sha256");
  signer.update(signingInput);
  const signature = signer.sign({ key, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return `${signingInput}.${signature}`;
}

export function appleAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: env("APPLE_OAUTH_CLIENT_ID")!,
    redirect_uri: `${publicUrl()}/api/auth/apple/callback`,
    response_type: "code",
    scope: "email",
    // Requesting any scope requires form_post — the callback arrives as a
    // POST with urlencoded body (handled in routes/auth.ts).
    response_mode: "form_post",
    state,
  });
  return `https://appleid.apple.com/auth/authorize?${params}`;
}

export async function exchangeAppleCode(code: string): Promise<OAuthIdentity> {
  const res = await fetch("https://appleid.apple.com/auth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env("APPLE_OAUTH_CLIENT_ID")!,
      client_secret: appleClientSecret(),
      redirect_uri: `${publicUrl()}/api/auth/apple/callback`,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) {
    logger.warn({ status: res.status, body: await res.text().catch(() => "") }, "Apple token exchange failed");
    throw new Error("Apple token exchange failed");
  }
  const data = (await res.json()) as { id_token?: string };
  if (!data.id_token) throw new Error("Apple response missing id_token");
  const claims = decodeJwtPayload(data.id_token);
  const sub = String(claims.sub ?? "");
  if (!sub) throw new Error("Apple id_token missing sub");
  return {
    provider: "apple",
    providerUserId: sub,
    email: typeof claims.email === "string" ? claims.email : null,
    displayName: null, // Apple only sends the name once, in the form_post body — not relied on
  };
}
