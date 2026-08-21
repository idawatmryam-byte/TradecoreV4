import type { ExecutionIntent } from "@workspace/db";
import type {
  ExposureRecoveryExecutor,
  ExposureRecoveryResult,
} from "./intentReconciliation";
import type { BrokerOrderEvidence } from "./reconciliationPolicy";

interface RecoveryEnvironment {
  exchange: any;
  toMarket: (symbol: string) => string;
  resolveOrder: (
    intent: Pick<
      ExecutionIntent,
      "id" | "symbol" | "side" | "marketType" | "clientOrderId"
    > &
      Partial<ExecutionIntent>,
  ) => Promise<BrokerOrderEvidence>;
  warn?: (context: unknown, message: string) => void;
}

function confirmedRecovery(raw: any): ExposureRecoveryResult | null {
  const status = String(
    raw?.status ?? raw?.info?.status ?? raw?.info?.state ?? "",
  ).toUpperCase();
  const filled = Number(raw?.filled ?? 0);
  if (
    (status === "CLOSED" || status === "FILLED") &&
    Number.isFinite(filled) &&
    filled > 0
  ) {
    return {
      outcome: "FLATTENED",
      brokerOrderId: raw?.id == null ? null : String(raw.id),
      filledQuantity: filled,
      evidenceSource: "broker-recovery-order",
    };
  }
  return null;
}

/**
 * Execute a stable compensating reduction for broker-proven exposure that has
 * no complete local trade. The command identity is persisted by the caller
 * first, so a restart resolves the same provider command instead of resending.
 */
export function createExposureRecoveryExecutor(
  environment: RecoveryEnvironment,
): ExposureRecoveryExecutor {
  return async (input) => {
    const ex = environment.exchange;
    const market = environment.toMarket(input.intent.symbol);
    let quantity = input.plan.quantity;

    if (input.plan.action === "CANCEL_REMAINDER_THEN_REDUCE") {
      if (!input.intent.clientOrderId || !input.evidence.brokerOrderId) {
        return {
          outcome: "ESCALATE",
          reasonCode: "RECOVERY_INTENT_IDENTITY_MISSING",
          reason:
            "The partial-fill recovery is missing its durable provider order identity",
        };
      }
      try {
        await ex.cancelOrder(input.evidence.brokerOrderId, market);
      } catch (cancelError) {
        environment.warn?.(
          { cancelError, intentId: input.intent.id },
          "Recovery cancellation did not confirm; checking the broker order before reducing exposure",
        );
      }
      let afterCancel: BrokerOrderEvidence;
      try {
        afterCancel = await environment.resolveOrder(input.intent);
      } catch {
        return {
          outcome: "RETRY",
          reasonCode: "RECOVERY_CANCEL_UNCONFIRMED",
          reason:
            "The partially filled entry remainder could not be confirmed canceled; exposure remains blocked and must not be guessed",
        };
      }
      if (afterCancel.status === "OPEN") {
        return {
          outcome: "RETRY",
          reasonCode: "RECOVERY_REMAINDER_STILL_OPEN",
          reason:
            "The partially filled entry still has an open remainder; reduction is deferred to avoid racing another fill",
        };
      }
      if (
        afterCancel.filledQuantity === null ||
        !Number.isFinite(afterCancel.filledQuantity) ||
        afterCancel.filledQuantity <= 0
      ) {
        return {
          outcome: "ESCALATE",
          reasonCode: "RECOVERY_FILL_LOST_AFTER_CANCEL",
          reason:
            "Broker evidence no longer contains a valid authoritative filled quantity after cancellation",
        };
      }
      quantity = afterCancel.filledQuantity;
    }

    if (input.intent.marketType === "forex") {
      if (
        !input.evidence.brokerTradeId ||
        typeof ex.closeTradeById !== "function"
      ) {
        return {
          outcome: "ESCALATE",
          reasonCode: "FOREX_RECOVERY_CLOSE_UNAVAILABLE",
          reason:
            "The authoritative OANDA trade cannot be closed by broker trade id",
        };
      }
      const result: any = await ex.closeTradeById(
        input.evidence.brokerTradeId,
        market,
        quantity,
      );
      const alreadyClosed = result?.info?.alreadyClosed === true;
      const filled = Number(result?.filled ?? 0);
      if (!alreadyClosed && (!Number.isFinite(filled) || filled <= 0)) {
        return {
          outcome: "RETRY",
          reasonCode: "FOREX_RECOVERY_CLOSE_UNCONFIRMED",
          reason:
            "OANDA did not return authoritative close confirmation for the recovered trade",
        };
      }
      return {
        outcome: "FLATTENED",
        brokerOrderId: result?.id == null ? null : String(result.id),
        filledQuantity: alreadyClosed ? 0 : filled,
        evidenceSource: alreadyClosed
          ? "oanda-open-trades-absence"
          : "oanda-trade-close-fill",
      };
    }

    const closeSide = input.intent.side === "buy" ? "sell" : "buy";
    const closeQuantity = Number(ex.amountToPrecision(market, quantity));
    if (!Number.isFinite(closeQuantity) || closeQuantity <= 0) {
      return {
        outcome: "ESCALATE",
        reasonCode: "RECOVERY_QUANTITY_NOT_EXECUTABLE",
        reason:
          "Authoritative exposure rounds to an invalid provider close quantity",
      };
    }

    const lookupRecovery = async (): Promise<any | null> => {
      try {
        return await ex.fetchOrder(input.recoveryClientOrderId, market, {
          origClientOrderId: input.recoveryClientOrderId,
        });
      } catch {
        return null;
      }
    };
    const prior = confirmedRecovery(await lookupRecovery());
    if (prior) return prior;

    if (input.intent.marketType === "spot") {
      if (closeSide !== "sell" || typeof ex.fetchBalance !== "function") {
        return {
          outcome: "ESCALATE",
          reasonCode: "SPOT_RECOVERY_POSITION_UNSUPPORTED",
          reason:
            "Spot recovery cannot prove a safe compensating asset reduction",
        };
      }
      let balance: any;
      try {
        balance = await ex.fetchBalance();
      } catch {
        return {
          outcome: "RETRY",
          reasonCode: "SPOT_RECOVERY_BALANCE_UNAVAILABLE",
          reason:
            "Authoritative spot balance is unavailable; no compensating sale was submitted",
        };
      }
      const base = market.split("/")[0];
      const available = Number(balance?.total?.[base]);
      if (!Number.isFinite(available) || available < 0) {
        return {
          outcome: "RETRY",
          reasonCode: "SPOT_RECOVERY_BALANCE_INVALID",
          reason:
            "Authoritative spot asset balance is invalid; no compensating sale was submitted",
        };
      }
      if (available === 0) {
        return {
          outcome: "FLATTENED",
          brokerOrderId: null,
          filledQuantity: 0,
          evidenceSource: "binance-spot-balance-absence",
        };
      }
      if (available < closeQuantity) {
        return {
          outcome: "ESCALATE",
          reasonCode: "SPOT_RECOVERY_EXPOSURE_CHANGED",
          reason:
            "Current authoritative spot balance is smaller than the recovered fill; manual or provider-side intervention requires evidence-backed resolution",
        };
      }
    }

    try {
      const close: any = await ex.createOrder(
        market,
        "market",
        closeSide,
        closeQuantity,
        undefined,
        {
          newClientOrderId: input.recoveryClientOrderId,
          ...(input.intent.marketType === "futures" && { reduceOnly: true }),
        },
      );
      const confirmed = confirmedRecovery(close);
      if (confirmed) return confirmed;
    } catch (closeError) {
      environment.warn?.(
        { closeError, intentId: input.intent.id },
        "Stable recovery close was not confirmed; resolving by its provider id",
      );
    }
    const afterSubmit = confirmedRecovery(await lookupRecovery());
    return (
      afterSubmit ?? {
        outcome: "RETRY",
        reasonCode: "RECOVERY_CLOSE_UNCONFIRMED",
        reason:
          "The stable exposure-reduction command has no authoritative fill confirmation; it will be reconciled by provider id",
      }
    );
  };
}
