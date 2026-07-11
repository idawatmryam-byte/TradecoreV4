/**
 * TradeCore Pro — Credentials encryption (multi-user Phase)
 *
 * Each user's Binance API key/secret are encrypted at rest with AES-256-GCM
 * before ever touching the database, using a server-side key
 * (CREDENTIALS_ENCRYPTION_KEY, validated at boot — see lib/env.ts). The
 * plaintext only ever exists in memory for the duration of a request or a
 * bot engine's connection setup; it is never logged and never returned to
 * the client once stored (the settings page only ever sees a masked
 * preview — see routes/credentials.ts).
 *
 * Format: `<ivHex>:<authTagHex>:<ciphertextHex>` — GCM's auth tag is stored
 * alongside the ciphertext so decryption fails loudly (not silently) if the
 * value has been tampered with or the key has changed.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit nonce, the GCM-recommended size

export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext.toString("hex")}`;
}

export function decryptSecret(encoded: string, key: Buffer): string {
  const parts = encoded.split(":");
  if (parts.length !== 3) {
    throw new Error("Malformed encrypted credential (expected iv:authTag:ciphertext)");
  }
  const [ivHex, authTagHex, ciphertextHex] = parts as [string, string, string];
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const ciphertext = Buffer.from(ciphertextHex, "hex");

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}
