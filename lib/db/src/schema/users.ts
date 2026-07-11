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
  /** scrypt-derived, never the raw password — see lib/passwordHash.ts. */
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

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
