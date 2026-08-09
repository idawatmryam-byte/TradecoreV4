import { sha256Fingerprint } from "../canonical";
import type { ResearchDecisionEvent, ResearchManagementEvent } from "./types";

export interface GoldenStreamValidation {
  expectedFingerprint: string;
  actualFingerprint: string;
  reproducible: boolean;
  eventCount: number;
}

export function decisionStreamFingerprint(
  decisions: readonly ResearchDecisionEvent[],
  management: readonly ResearchManagementEvent[] = [],
): string {
  const orderedDecisions = [...decisions]
    .sort((a, b) => a.sequence - b.sequence || a.symbol.localeCompare(b.symbol))
    .map((event) => event.fingerprint);
  const orderedManagement = [...management]
    .sort((a, b) => a.sequence - b.sequence || a.tradeId - b.tradeId)
    .map((event) => event.fingerprint);
  return sha256Fingerprint({
    version: "phase8-golden-stream-v1",
    decisions: orderedDecisions,
    management: orderedManagement,
  });
}

export function validateGoldenDecisionStream(
  expectedFingerprint: string,
  decisions: readonly ResearchDecisionEvent[],
  management: readonly ResearchManagementEvent[] = [],
): GoldenStreamValidation {
  if (!/^[a-f0-9]{64}$/i.test(expectedFingerprint)) {
    throw new Error("Expected golden-stream fingerprint must be SHA-256");
  }
  const actualFingerprint = decisionStreamFingerprint(decisions, management);
  return Object.freeze({
    expectedFingerprint,
    actualFingerprint,
    reproducible:
      expectedFingerprint.toLowerCase() === actualFingerprint.toLowerCase(),
    eventCount: decisions.length + management.length,
  });
}
