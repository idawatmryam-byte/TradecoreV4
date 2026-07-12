/**
 * TradeCore Pro — Password hashing (multi-user Phase)
 *
 * scrypt (Node's built-in, no extra native dependency) with a random salt
 * per user. Format: `<saltHex>:<derivedKeyHex>`. Verification recomputes the
 * derived key from the candidate password with the SAME salt and compares
 * with a timing-safe equal, so a wrong password can't be distinguished from
 * a right one by response timing.
 */
import { randomBytes, scrypt, timingSafeEqual } from "crypto";
import { promisify } from "util";

const scryptAsync = promisify(scrypt);
const KEY_LENGTH = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derivedKey = (await scryptAsync(password, salt, KEY_LENGTH)) as Buffer;
  return `${salt.toString("hex")}:${derivedKey.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(":");
  if (parts.length !== 2) return false;
  const [saltHex, keyHex] = parts as [string, string];

  let salt: Buffer;
  let expectedKey: Buffer;
  try {
    salt = Buffer.from(saltHex, "hex");
    expectedKey = Buffer.from(keyHex, "hex");
  } catch {
    return false;
  }
  if (expectedKey.length !== KEY_LENGTH) return false;

  const candidateKey = (await scryptAsync(password, salt, KEY_LENGTH)) as Buffer;
  return timingSafeEqual(candidateKey, expectedKey);
}
