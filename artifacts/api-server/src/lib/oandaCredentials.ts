/**
 * TradeCore Pro — per-user OANDA credential storage (Forex section)
 *
 * Mirror of binanceCredentials.ts for the OANDA token + account id pair —
 * the ONLY place their plaintext exists outside the request that just
 * decrypted them (a forex engine's initExchange(), or the settings PUT).
 * Never log the return value of getOandaCredentials().
 */
import { db } from "@workspace/db";
import { userOandaCredentialsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { encryptSecret, decryptSecret } from "./credentialsCrypto";
import { validateEnv } from "./env";

export interface OandaCredentials {
  token: string;
  accountId: string;
}

export async function getOandaCredentials(userId: number): Promise<OandaCredentials | null> {
  const [row] = await db
    .select()
    .from(userOandaCredentialsTable)
    .where(eq(userOandaCredentialsTable.userId, userId));
  if (!row) return null;

  const { credentialsEncryptionKey } = validateEnv();
  return {
    token: decryptSecret(row.encryptedToken, credentialsEncryptionKey),
    accountId: decryptSecret(row.encryptedAccountId, credentialsEncryptionKey),
  };
}

export async function getOandaCredentialsStatus(
  userId: number,
): Promise<{ configured: boolean; accountIdPreview: string | null; updatedAt: string | null }> {
  const [row] = await db
    .select()
    .from(userOandaCredentialsTable)
    .where(eq(userOandaCredentialsTable.userId, userId));
  if (!row) return { configured: false, accountIdPreview: null, updatedAt: null };
  return {
    configured: true,
    accountIdPreview: row.accountIdPreview,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function setOandaCredentials(userId: number, token: string, accountId: string): Promise<void> {
  const { credentialsEncryptionKey } = validateEnv();
  const encryptedToken = encryptSecret(token, credentialsEncryptionKey);
  const encryptedAccountId = encryptSecret(accountId, credentialsEncryptionKey);
  const accountIdPreview = accountId.length > 4 ? `...${accountId.slice(-4)}` : "...";

  await db
    .insert(userOandaCredentialsTable)
    .values({ userId, encryptedToken, encryptedAccountId, accountIdPreview })
    .onConflictDoUpdate({
      target: userOandaCredentialsTable.userId,
      set: { encryptedToken, encryptedAccountId, accountIdPreview, updatedAt: new Date() },
    });
}

export async function deleteOandaCredentials(userId: number): Promise<void> {
  await db.delete(userOandaCredentialsTable).where(eq(userOandaCredentialsTable.userId, userId));
}
