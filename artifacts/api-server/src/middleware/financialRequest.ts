import type { Request } from "express";

/** Fail closed when a cookie-authenticated financial mutation is not same-origin. */
export function verifyFinancialRequestOrigin(
  req: Request,
): { ok: true } | { ok: false; reason: string } {
  if (req.authMethod === "basic") return { ok: true };
  const fetchSite = req.get("sec-fetch-site")?.toLowerCase();
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    return { ok: false, reason: "Cross-site financial actions are not permitted" };
  }
  const origin = req.get("origin");
  const host = req.get("host");
  if (!origin || !host) {
    return { ok: false, reason: "Financial actions require a verifiable same-origin browser request" };
  }
  try {
    if (new URL(origin).host !== host) {
      return { ok: false, reason: "Cross-origin financial actions are not permitted" };
    }
  } catch {
    return { ok: false, reason: "Financial action origin is invalid" };
  }
  return { ok: true };
}
