import { pgTable, serial, integer, text, timestamp, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// ---------------------------------------------------------------------------
// Users — each user runs their own fully independent bot instance (own
// trades, config, strategy configs, blacklist/toxic-hour memory, backtests)
// against their own Binance account, via their own encrypted credentials
// below. See lib/engineRegistry.ts (api-server) for how a userId maps to a
// running BotEngine instance.
// ---------------------------------------------------------------------------

export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  /** scrypt-derived, never the raw password — see lib/passwordHash.ts.
   *  NULL for accounts created via Google/Apple sign-in that never set a
   *  password; they can add one later on the Account page. */
  passwordHash: text("password_hash"),
  /** From the OAuth provider (or set on the Account page). Informational —
   *  login identity is username or a linked provider, never email lookup. */
  email: text("email"),
  /** Optional friendly display name (defaults to username in the UI). */
  displayName: text("display_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Linked sign-in identities — one row per (provider, provider account) pair.
// A user may link Google and/or Apple to the same TradeCore account; logging
// in with a linked provider resolves to the same userId (and the same bot,
// trades, credentials). providerUserId is the provider's stable subject id
// ("sub" claim) — NEVER the email, which providers allow users to change.
// ---------------------------------------------------------------------------
export const userIdentitiesTable = pgTable("user_identities", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  provider: text("provider").notNull(), // google | apple
  providerUserId: text("provider_user_id").notNull(),
  /** Email as reported by the provider at link time (informational). */
  email: text("email"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("user_identities_provider_subject_unique").on(t.provider, t.providerUserId),
]);

export type UserIdentity = typeof userIdentitiesTable.$inferSelect;

export const insertUserSchema = createInsertSchema(usersTable).omit({
  id: true,
  createdAt: true,
});
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;

// ---------------------------------------------------------------------------
// Per-user Binance API credentials — encrypted at rest (AES-256-GCM, see
// lib/credentialsCrypto.ts in api-server). The server never stores or
// returns the plaintext key/secret once written; only a masked preview is
// ever shown back to the owning user.
// ---------------------------------------------------------------------------

export const userBinanceCredentialsTable = pgTable("user_binance_credentials", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  /** `<ivHex>:<authTagHex>:<ciphertextHex>` — see encryptSecret()/decryptSecret(). */
  encryptedApiKey: text("encrypted_api_key").notNull(),
  encryptedApiSecret: text("encrypted_api_secret").notNull(),
  /** Last 4 chars of the plaintext API key, kept in the clear so the
   *  settings page can show "configured: ...ab12" without ever decrypting. */
  apiKeyPreview: text("api_key_preview").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [
  unique("user_binance_credentials_user_id_unique").on(t.userId),
]);

export const insertUserBinanceCredentialsSchema = createInsertSchema(userBinanceCredentialsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertUserBinanceCredentials = z.infer<typeof insertUserBinanceCredentialsSchema>;
export type UserBinanceCredentials = typeof userBinanceCredentialsTable.$inferSelect;

// ---------------------------------------------------------------------------
// Per-user OANDA credentials (forex section) — a personal access token plus
// the account id it belongs to, both encrypted at rest with the same
// AES-256-GCM scheme as the Binance keys. A deliberately PARALLEL table, not
// a generalized "provider" column on the Binance one: the secret shape is
// different (token + accountId vs key + secret), there is exactly one hot
// read site per broker, and keeping them separate avoids ever migrating
// encrypted blobs between schemas.
// ---------------------------------------------------------------------------

export const userOandaCredentialsTable = pgTable("user_oanda_credentials", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  /** `<ivHex>:<authTagHex>:<ciphertextHex>` — see encryptSecret()/decryptSecret(). */
  encryptedToken: text("encrypted_token").notNull(),
  encryptedAccountId: text("encrypted_account_id").notNull(),
  /** Last 4 chars of the plaintext account id, kept in the clear so the
   *  settings page can show "configured: ...4567" without ever decrypting. */
  accountIdPreview: text("account_id_preview").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [
  unique("user_oanda_credentials_user_id_unique").on(t.userId),
]);

export type UserOandaCredentials = typeof userOandaCredentialsTable.$inferSelect;
