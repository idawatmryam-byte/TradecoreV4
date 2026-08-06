import { createHash } from "node:crypto";

/** JSON-compatible recursive value accepted by canonical hashing. */
export type CanonicalValue =
  | null | boolean | number | string
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

function encode(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error("Canonical payload contains a non-finite number");
    }
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("Canonical payload contains a non-serializable value");
    return encoded;
  }
  if (Array.isArray(value)) return "[" + value.map(encode).join(",") + "]";
  const record = value as Record<string, unknown>;
  return "{" + Object.keys(record).sort().map((key) => JSON.stringify(key) + ":" + encode(record[key])).join(",") + "}";
}

export function canonicalJson(value: unknown): string {
  return encode(value);
}

export function sha256Fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export type ReadonlyDeep<T> =
  T extends (...args: never[]) => unknown ? T :
  T extends readonly (infer U)[] ? readonly ReadonlyDeep<U>[] :
  T extends object ? { readonly [K in keyof T]: ReadonlyDeep<T[K]> } :
  T;

export function deepFreeze<T>(value: T): ReadonlyDeep<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value as ReadonlyDeep<T>;
}
