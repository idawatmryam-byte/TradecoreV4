import { logger } from "./logger";

export type CriticalOperatorAlertCode =
  | "PROTECTIVE_CLOSE_FAILED"
  | "EXECUTION_AUTHORITY_AMBIGUOUS"
  | "RECONCILIATION_UNKNOWN"
  | "UNCAUGHT_EXCEPTION"
  | "UNHANDLED_REJECTION";

export interface CriticalOperatorAlert {
  code: CriticalOperatorAlertCode;
  summary: string;
  dedupeKey: string;
  userId?: number;
  section?: string;
  tradeId?: number;
  symbol?: string;
  provider?: string;
  executionAuthority?: string;
  detail?: string;
}

const deliveredAt = new Map<string, number>();
const attemptedAt = new Map<string, number>();
const DELIVERY_DEDUPE_MS = 5 * 60_000;
const FAILED_ATTEMPT_RATE_LIMIT_MS = 30_000;

function webhookUrl(): string {
  return (process.env.OPS_ALERT_WEBHOOK_URL ?? "").trim();
}

function safeText(value: unknown, maximum = 500): string {
  return String(value ?? "")
    .replace(/[\r\n]+/g, " ")
    .slice(0, maximum);
}

function structuredEvent(alert: CriticalOperatorAlert) {
  return {
    schemaVersion: "tradecore-critical-alert-v1",
    severity: "critical",
    code: alert.code,
    occurredAt: new Date().toISOString(),
    summary: safeText(alert.summary),
    context: {
      ...(Number.isInteger(alert.userId) && { userId: alert.userId }),
      ...(alert.section && { section: safeText(alert.section, 40) }),
      ...(Number.isInteger(alert.tradeId) && { tradeId: alert.tradeId }),
      ...(alert.symbol && { symbol: safeText(alert.symbol, 80) }),
      ...(alert.provider && { provider: safeText(alert.provider, 40) }),
      ...(alert.executionAuthority && {
        executionAuthority: safeText(alert.executionAuthority, 80),
      }),
      ...(alert.detail && { detail: safeText(alert.detail) }),
    },
  };
}

async function deliver(url: string, body: unknown): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError;
}

/**
 * Log every critical event first, then best-effort deliver it out of band.
 * Delivery failure can never replace or hide the original financial error.
 */
export async function emitCriticalOperatorAlert(
  alert: CriticalOperatorAlert,
): Promise<"delivered" | "deduplicated" | "not_configured" | "failed"> {
  const event = structuredEvent(alert);
  logger.error({ operatorAlert: event }, "CRITICAL_OPERATOR_ALERT");

  const now = Date.now();
  const key = `${alert.code}:${alert.dedupeKey}`;
  if (now - (deliveredAt.get(key) ?? 0) < DELIVERY_DEDUPE_MS)
    return "deduplicated";
  if (now - (attemptedAt.get(key) ?? 0) < FAILED_ATTEMPT_RATE_LIMIT_MS)
    return "deduplicated";
  attemptedAt.set(key, now);

  const url = webhookUrl();
  if (!url) {
    logger.error(
      { code: alert.code },
      "CRITICAL_OPERATOR_ALERT_NOT_CONFIGURED — set OPS_ALERT_WEBHOOK_URL",
    );
    return "not_configured";
  }

  const text = `🚨 TradeCore ${event.code}: ${event.summary}`.slice(0, 1800);
  try {
    await deliver(url, { content: text, text, event });
    deliveredAt.set(key, Date.now());
    logger.info({ code: alert.code }, "CRITICAL_OPERATOR_ALERT_DELIVERED");
    return "delivered";
  } catch (error) {
    logger.error(
      { err: error, code: alert.code },
      "CRITICAL_OPERATOR_ALERT_DELIVERY_FAILED",
    );
    return "failed";
  }
}

/** Test seam; production code never clears alert suppression state. */
export function resetOperatorAlertStateForTests(): void {
  deliveredAt.clear();
  attemptedAt.clear();
}
