export interface BrokerOrderEvidence {
  readonly brokerOrderId: string | null;
  readonly status: "OPEN" | "FILLED" | "CANCELED" | "REJECTED" | "UNKNOWN";
  readonly requestedQuantity: number | null;
  readonly filledQuantity: number | null;
  readonly averageFillPrice: number | null;
  readonly brokerTradeId: string | null;
}

export type ReconciliationClassification =
  | {
      state: "FAILED";
      reasonCode: "BROKER_REJECTED" | "BROKER_CANCELED_UNFILLED";
    }
  | { state: "PARTIALLY_FILLED"; reasonCode: "BROKER_PARTIAL_FILL" }
  | { state: "FILLED"; reasonCode: "BROKER_FILL_CONFIRMED" }
  | {
      state: "RECONCILIATION_REQUIRED";
      reasonCode: "BROKER_ORDER_PENDING" | "BROKER_EVIDENCE_UNKNOWN";
    };

export type ExposureRecoveryPlan =
  | {
      action: "NONE";
      reasonCode: "LOCAL_TRADE_PRESENT" | "NO_AUTHORITATIVE_EXPOSURE";
    }
  | {
      action: "CANCEL_REMAINDER_THEN_REDUCE" | "REDUCE";
      quantity: number;
      reasonCode:
        | "AUTHORITATIVE_PARTIAL_EXPOSURE"
        | "AUTHORITATIVE_FILLED_EXPOSURE";
    }
  | {
      action: "ESCALATE";
      reasonCode:
        | "INVALID_FILL_EVIDENCE"
        | "FOREX_TRADE_ID_REQUIRED"
        | "OPEN_ORDER_ID_REQUIRED";
    };

function validPositive(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

/** Pure, provider-independent financial-state classification. */
export function classifyBrokerOrder(
  evidence: BrokerOrderEvidence,
): ReconciliationClassification {
  const filled = validPositive(evidence.filledQuantity)
    ? evidence.filledQuantity
    : 0;
  const requested = validPositive(evidence.requestedQuantity)
    ? evidence.requestedQuantity
    : null;

  if (filled > 0 && requested !== null && filled < requested) {
    return { state: "PARTIALLY_FILLED", reasonCode: "BROKER_PARTIAL_FILL" };
  }
  if (filled > 0 || evidence.status === "FILLED") {
    return { state: "FILLED", reasonCode: "BROKER_FILL_CONFIRMED" };
  }
  if (evidence.status === "REJECTED") {
    return { state: "FAILED", reasonCode: "BROKER_REJECTED" };
  }
  if (evidence.status === "CANCELED") {
    return { state: "FAILED", reasonCode: "BROKER_CANCELED_UNFILLED" };
  }
  if (evidence.status === "OPEN") {
    return {
      state: "RECONCILIATION_REQUIRED",
      reasonCode: "BROKER_ORDER_PENDING",
    };
  }
  return {
    state: "RECONCILIATION_REQUIRED",
    reasonCode: "BROKER_EVIDENCE_UNKNOWN",
  };
}

/**
 * Decide the only safe action for broker-proven exposure that lacks a local
 * trade. The plan never infers a fill: quantity and price must both come from
 * authoritative provider evidence. The caller performs the provider action.
 */
export function planExposureRecovery(input: {
  evidence: BrokerOrderEvidence;
  marketType: string;
  localTradeId: number | null;
}): ExposureRecoveryPlan {
  if (input.localTradeId !== null) {
    return { action: "NONE", reasonCode: "LOCAL_TRADE_PRESENT" };
  }
  const classification = classifyBrokerOrder(input.evidence);
  if (
    classification.state === "FAILED" ||
    (!validPositive(input.evidence.filledQuantity) &&
      input.evidence.status !== "FILLED")
  ) {
    return { action: "NONE", reasonCode: "NO_AUTHORITATIVE_EXPOSURE" };
  }
  if (
    !validPositive(input.evidence.filledQuantity) ||
    !validPositive(input.evidence.averageFillPrice)
  ) {
    return { action: "ESCALATE", reasonCode: "INVALID_FILL_EVIDENCE" };
  }
  if (input.marketType === "forex" && !input.evidence.brokerTradeId) {
    return { action: "ESCALATE", reasonCode: "FOREX_TRADE_ID_REQUIRED" };
  }
  if (
    classification.state === "PARTIALLY_FILLED" &&
    input.evidence.status === "OPEN" &&
    !input.evidence.brokerOrderId
  ) {
    return { action: "ESCALATE", reasonCode: "OPEN_ORDER_ID_REQUIRED" };
  }
  return {
    action:
      classification.state === "PARTIALLY_FILLED" &&
      input.evidence.status === "OPEN"
        ? "CANCEL_REMAINDER_THEN_REDUCE"
        : "REDUCE",
    quantity: input.evidence.filledQuantity,
    reasonCode:
      classification.state === "PARTIALLY_FILLED"
        ? "AUTHORITATIVE_PARTIAL_EXPOSURE"
        : "AUTHORITATIVE_FILLED_EXPOSURE",
  };
}
