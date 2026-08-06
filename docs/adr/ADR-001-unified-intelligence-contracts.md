# ADR-001: Compatibility-first unified intelligence contracts and MarketState

**Status:** Accepted  
**Date:** 2026-08-06  
**Deciders:** Product owner and TradeCore architecture owner

## Context

TradeCore's existing Brain V0 path is financially active and parity-tested:

```text
multi-timeframe candles → SignalRow → strategies → TradePlan
→ deterministic risk gates → Research / Co-Pilot / Demo / Live executor
```

Phases 1–2 require a richer decision vocabulary and shared market perception without changing that money path before the new system has research and shadow evidence.

Constraints:

- no uncontrolled AI-to-broker route;
- no Demo or Live behavior change in Phases 1–2;
- closed, point-in-time market data only;
- strict runtime validation and reproducible fingerprints;
- provider-neutral domain contracts;
- append-only auditability;
- horizontally scalable public market-state semantics;
- existing OpenAPI, Drizzle, React Query, and capture infrastructure should be reused.

## Decision

Introduce a versioned internal intelligence domain under `artifacts/api-server/src/lib/intelligence/`.

1. Strict Zod schemas define Opportunity, StrategyOpinion, MemoryEvidence, PortfolioContext, TradeThesis, ProposedTradePlan, BrainDecision, RiskDecision, and ExecutionCommand.
2. Parsed decisions are deeply frozen and canonically SHA-256 fingerprinted.
3. An explicit adapter converts Brain V0 TradePlan values to and from the new ProposedTradePlan/BrainDecision shape.
4. MarketState is a separate immutable point-in-time contract built only from validated closed candles.
5. MarketState distinguishes observations from inferences and marks optional breadth, leadership, and correlation context unavailable instead of fabricating values.
6. Stale, insufficient, unsorted, contradictory, invalid, or non-finite market data refuses state generation.
7. New decisions and evidence references use the existing append-only `capture` PostgreSQL schema.
8. Initial engine integration is observational and read-only. MarketState cannot affect strategy selection, risk, or execution in this phase.
9. OpenAPI is the external API source; generated packages must be regenerated before the stacked PR becomes ready for review.

## Options considered

### Option A: Replace SignalRow and TradePlan in the live path immediately

| Dimension | Assessment |
|---|---|
| Complexity | High |
| Financial risk | Unacceptable for this phase |
| Migration speed | Superficially fast |
| Rollback | Difficult |
| Audit confidence | Low until parity is reproven |

Pros:

- one representation immediately;
- less temporary adapter code.

Cons:

- changes strategy, risk, and execution boundaries simultaneously;
- invalidates the Phase 0 control;
- makes regressions difficult to attribute;
- violates Research → Shadow → supervised promotion.

### Option B: Compatibility-first domain layer with explicit adapters

| Dimension | Assessment |
|---|---|
| Complexity | Medium |
| Financial risk | Low |
| Migration speed | Incremental |
| Rollback | Straightforward |
| Audit confidence | High |

Pros:

- Brain V0 remains frozen;
- every subsystem can migrate independently;
- contracts and MarketState can be tested before influencing money;
- decisions remain reproducible and append-only;
- adapter parity is directly testable.

Cons:

- temporary dual representations;
- adapter and version governance must remain disciplined;
- observational computation adds bounded CPU work.

### Option C: Continue storing loose JSON in existing decision records

| Dimension | Assessment |
|---|---|
| Complexity | Low initially |
| Financial risk | High over time |
| Extensibility | Poor |
| Runtime safety | Poor |
| Audit confidence | Low |

Pros:

- minimal initial code.

Cons:

- malformed and contradictory decisions reach downstream consumers;
- versioning and replay remain ambiguous;
- UI and server drift;
- no enforceable evidence or uncertainty semantics.

## Trade-off analysis

Option B adds explicit migration code, but it preserves the frozen control and creates narrow, testable seams. This is the only option consistent with financial promotion gates and long-term modularity.

The append-only capture schema is reused because it already has database-level INSERT/SELECT-only grants and correct separation from the mutable, deduplicated Decisions feed. A new database or event bus would add operational complexity without improving Phase 1–2 correctness.

MarketState is per-symbol in this phase. Cross-symbol breadth, leadership, and correlation are optional typed context because pretending to have them from one symbol would be false. Phase 6 can provide portfolio-wide context through the same contract.

## Security implications

- Strict schemas reject unknown fields and non-finite values.
- ExecutionCommand requires a risk decision, plan fingerprint, expiry, idempotency key, and authorization reference.
- No contract or MarketState builder owns a broker dependency.
- Untrusted narrative evidence is data, never executable instruction.
- Append-only records exclude secrets and credential material.
- The initial API surface is read-only and authenticated through the existing application gate.

## Scalability and reliability

MarketState construction is pure and deterministic over closed candles. It can later move to shared workers and be cached by input fingerprint without changing consumers.

The builder returns structured refusal issues. Callers fail closed for intelligence while the legacy Brain V0 decision path remains unchanged during observational rollout.

Large raw candle arrays are not stored inside every BrainDecision. Market-state and evidence fingerprints provide deduplicated references.

## Consequences

Easier:

- independent specialist, council, portfolio, and learning modules;
- deterministic replay and contract validation;
- UI distinction between facts, inference, uncertainty, and actions;
- gradual migration with parity tests.

Harder:

- two decision representations exist temporarily;
- OpenAPI code generation becomes a required review gate;
- every version and adapter must remain backward compatible until Brain V0 retires.

## Action items

- [x] Add strict intelligence contracts and canonical hashing.
- [x] Add the Brain V0 TradePlan adapter and parity tests.
- [x] Add closed-candle MarketState construction and refusal tests.
- [x] Add append-only brain decision/evidence schema definitions.
- [ ] Regenerate API Zod and React Query packages.
- [ ] Expose observational MarketState through an authenticated read-only endpoint.
- [ ] Add Market Overview and enriched Decisions UI.
- [ ] Run full typecheck, unit, integration, and browser suites.
- [ ] Keep the stacked PR draft until Phase 0 merges and all gates pass.
