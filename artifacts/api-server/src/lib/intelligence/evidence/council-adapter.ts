import {
  INTELLIGENCE_SCHEMA_VERSION,
  MemoryEvidenceSchema,
  type MemoryEvidence,
} from "../contracts";
import { deepFreeze, sha256Fingerprint } from "../canonical";
import type { HistoricalEvidenceContext } from "../council/types";
import type { InfluenceRule, InfluenceState } from "../../memory/influence";

const EVIDENCE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function deterministicUuid(value: unknown): string {
  const chars = sha256Fingerprint(value).slice(0, 32).split("");
  chars[12] = "5";
  chars[16] = ((Number.parseInt(chars[16]!, 16) & 0x3) | 0x8).toString(16);
  const hex = chars.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function scopeOf(rule: InfluenceRule): MemoryEvidence["scope"] {
  if (rule.dimension === "strategy_regime") {
    const [strategyId, regime] = rule.key.split("|");
    return { strategyId: strategyId ?? null, regime: regime ?? null, symbolClass: null, direction: null };
  }
  if (rule.dimension === "symbol_strategy") {
    const [, strategyId] = rule.key.split("|");
    return { strategyId: strategyId ?? null, regime: null, symbolClass: null, direction: null };
  }
  return { strategyId: null, regime: null, symbolClass: null, direction: null };
}

/**
 * The Shadow Council receives only the exact state already authorized at the
 * engine seam. Observational and merely validated Shadow evidence is absent.
 */
export function approvedHistoricalEvidence(state: InfluenceState): HistoricalEvidenceContext {
  if (!state.enabled || state.rules.length === 0 || state.version === "memory-0") {
    return deepFreeze({
      status: "unavailable",
      ruleVersion: null,
      items: [],
      limitations: ["No exact evidence version is active; observational and Shadow evidence cannot influence the council."],
    });
  }

  const items = state.rules.map((rule) => {
    const fingerprint = sha256Fingerprint({ ruleVersion: state.version, rule });
    return MemoryEvidenceSchema.parse({
      schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
      evidenceId: deterministicUuid({ fingerprint, type: "approved-memory-evidence" }),
      ruleVersion: state.version,
      state: "approved",
      scope: scopeOf(rule),
      sampleSize: rule.samples,
      estimate: rule.winRate,
      interval: {
        lower: rule.winRateLow,
        upper: rule.winRateHigh,
        confidenceLevel: 0.95,
      },
      permits: "withhold",
      dataCutoff: new Date(state.asOf).toISOString(),
      expiresAt: new Date(state.asOf + EVIDENCE_TTL_MS).toISOString(),
      fingerprint,
    });
  });

  return deepFreeze({
    status: "approved",
    ruleVersion: state.version,
    items,
    limitations: [
      "Approved evidence can only withhold a matching candidate; it cannot increase conviction or originate a trade.",
      "Portfolio-aware risk reduction remains unavailable until Phase 6.",
    ],
  });
}
