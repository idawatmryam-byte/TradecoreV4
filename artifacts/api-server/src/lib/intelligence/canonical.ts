import { createHash } from "node:crypto";

/** JSON-compatible recursive value accepted by canonical hashing. */
export type CanonicalValue =
  | null | boolean | number | string
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

function fail(path: string, detail: string): never {
  throw new Error(`Canonical payload ${detail} at ${path}`);
}

function encode(value: unknown, path: string, ancestors: WeakSet<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(path, "contains a non-finite number");
    return JSON.stringify(value);
  }
  if (value === undefined) fail(path, "contains undefined outside an optional object member");
  if (typeof value === "bigint") fail(path, "contains a BigInt");
  if (typeof value === "function") fail(path, "contains a function");
  if (typeof value === "symbol") fail(path, "contains a symbol");
  if (typeof value !== "object") fail(path, "contains a non-serializable value");

  if (ancestors.has(value)) fail(path, "contains a cyclic reference");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return "[" + value.map((item, index) => encode(item, `${path}[${index}]`, ancestors)).join(",") + "]";
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail(path, `contains unsupported object ${prototype?.constructor?.name ?? "unknown"}`);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) fail(path, "contains symbol-keyed fields");

    const record = value as Record<string, unknown>;
    const fields: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (descriptor?.get || descriptor?.set) fail(`${path}.${key}`, "contains an accessor property");
      // Optional object members are absent in JSON. Omitting only literal
      // undefined preserves the established contract without coercing or
      // dropping any concrete financial value. Undefined in arrays/root is
      // rejected above because its position is semantically meaningful.
      if (record[key] === undefined) continue;
      fields.push(`${JSON.stringify(key)}:${encode(record[key], `${path}.${key}`, ancestors)}`);
    }
    return `{${fields.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  return encode(value, "$", new WeakSet());
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
