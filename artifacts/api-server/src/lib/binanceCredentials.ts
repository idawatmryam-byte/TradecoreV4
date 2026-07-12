/**
 * TradeCore Pro — per-user Binance credential storage (Multi-user Phase)
 *
 * Thin wrapper around userBinanceCredentialsTable + credentialsCrypto.ts —
 * the ONLY place plaintext API key/secret exist outside of the request that
 * just decrypted them (a bot engine's initExchange() call, or the settings
 * page's own PUT). Never log the return value of getBinanceCredentials().
 */
import { db } from "@workspace/db";
import { userBinanceCredentialsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { encryptSecret, decryptSecret } from "./credentialsCrypto";
import { validateEnv } from "./env";

export interface BinanceCredentials {
  apiKey: string;
  apiSecret: string;
}

export async function getBinanceCredentials(userId: number): Promise<BinanceCredentials | null> {
  const [row] = await db
    .select()
    .from(userBinanceCredentialsTable)
    .where(eq(userBinanceCredentialsTable.userId, userId));
  if (!row) return null;

  const { credentialsEncryptionKey } = validateEnv();
  return {
    apiKey: decryptSecret(row.encryptedApiKey, credentialsEncryptionKey),
    apiSecret: decryptSecret(row.encryptedApiSecret, credentialsEncryptionKey),
  };
}

export async function getBinanceCredentialsStatus(
  userId: number,
): Promise<{ configured: boolean; apiKeyPreview: string | null; updatedAt: string | null }> {
  const [row] = await db
    .select()
    .from(userBinanceCredentialsTable)
    .where(eq(userBinanceCredentialsTable.userId, userId));
  if (!row) return { configured: false, apiKeyPreview: null, updatedAt: null };
  return {
    configured: true,
    apiKeyPreview: row.apiKeyPreview,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function setBinanceCredentials(userId: number, apiKey: string, apiSecret: string): Promise<void> {
  const { credentialsEncryptionKey } = validateEnv();
  const encryptedApiKey = encryptSecret(apiKey, credentialsEncryptionKey);
  const encryptedApiSecret = encryptSecret(apiSecret, credentialsEncryptionKey);
  const apiKeyPreview = apiKey.length > 4 ? `...${apiKey.slice(-4)}` : "...";

  await db
    .insert(userBinanceCredentialsTable)
    .values({ userId, encryptedApiKey, encryptedApiSecret, apiKeyPreview })
    .onConflictDoUpdate({
      target: userBinanceCredentialsTable.userId,
      set: { encryptedApiKey, encryptedApiSecret, apiKeyPreview, updatedAt: new Date() },
    });
}

export async function deleteBinanceCredentials(userId: number): Promise<void> {
  await db.delete(userBinanceCredentialsTable).where(eq(userBinanceCredentialsTable.userId, userId));
}
