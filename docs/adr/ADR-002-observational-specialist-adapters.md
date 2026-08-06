# ADR-002: Project Brain V0 strategies as observational specialists

**Status:** Accepted  
**Date:** 2026-08-06  
**Deciders:** Product owner and TradeCore architecture owner

## Context

Phase 3 must make the existing strategy catalog cooperate through the Phase 1 `StrategyOpinion` contract without changing the frozen Brain V0 control or granting a strategy new authority.

The current selector already owns several proven safety and compatibility properties:

- every strategy evaluates the same `SignalRow` and multi-timeframe candles;
- native `decide()` and legacy `evaluate()` strategies converge on `TradePlan` or `TradeRejection`;
- the centralized cost-aware reward/risk floor applies to every path;
- strategies cannot call the broker;
- live and backtest engines share the selector;
- custom strategies pass through the same gates.

Replacing this path during Phase 3 would make parity failures difficult to attribute and would invalidate Phase 0 measurements.

## Decision

Phase 3 uses a one-way compatibility projection:

```text
unchanged Brain V0 selector
        ↓
TradePlan / TradeRejection / no setup
        ↓
StrategySpecialistAdapter + immutable MarketState
        ↓
validated StrategyOpinion
        ↓
correlation-discounted observational council
        ↓
read-only API, UI, and append-only capture
```

1. `MarketSpecialist` consumes immutable `MarketState` plus the already-produced compatibility outcome.
2. Every enabled, regime-eligible strategy emits an opinion. A missing setup becomes an explicit abstention instead of disappearing.
3. Plans map to long/short opinions. Rejections map to opposing evidence and an abstention reason.
4. Opinion IDs are deterministic over specialist version, MarketState fingerprint, and compatibility outcome.
5. Similar hypotheses are assigned a correlation group. Repeated opinions in the same group and direction receive diminishing informational weights of 1, 0.5, and 0.25.
6. Correlation-adjusted scores are presentation and research metadata only. The selector, risk gates, executors, and broker boundary do not read them.
7. Opinions, including abstentions, are stored append-only and deduplicated by deterministic opinion ID.
8. The Strategies page becomes a Specialist Council with explicit mandates, suitable regimes, evidence for/against, uncertainty, abstention, disagreement, and calibration status.
9. Existing strategy configuration remains available. Advanced and overfitting-prone controls stay behind the existing disclosure.
10. Statistical calibration is reported as unavailable until Phase 5 provides validated evidence. The UI must not infer calibration from win rate alone.

## Options considered

### Option A: Rewrite every strategy to return StrategyOpinion directly

| Dimension | Assessment |
|---|---|
| Brain V0 parity | High risk |
| Migration complexity | High |
| Rollback | Difficult |
| Long-term shape | Clean after migration |

Pros:

- one native output per strategy;
- no compatibility projection after migration.

Cons:

- changes all built-in and custom strategy behavior at once;
- risks moving or duplicating the central cost floor;
- makes Phase 3 performance differences impossible to attribute;
- forces live and backtest migration before specialist evidence exists.

### Option B: One-way compatibility projection after the selector

| Dimension | Assessment |
|---|---|
| Brain V0 parity | Preserved |
| Migration complexity | Medium |
| Rollback | Straightforward |
| Auditability | High |

Pros:

- exact existing plans and rejections become the source of truth;
- abstentions become measurable;
- specialist contracts and UI can mature without money-path changes;
- native specialist evaluation can be introduced one strategy at a time later.

Cons:

- Phase 3 opinions describe existing decisions rather than independently replacing them;
- a temporary dual representation remains;
- specialist quality cannot yet be statistically calibrated.

### Option C: Build an independent second evaluation pass for each strategy

| Dimension | Assessment |
|---|---|
| Brain V0 parity | Preserved in execution |
| CPU cost | High |
| Drift risk | High |
| Auditability | Medium |

Pros:

- opinions could diverge from Brain V0 immediately;
- no selector changes.

Cons:

- duplicate indicator and strategy computation;
- two evaluations can disagree because of implementation drift rather than an independent hypothesis;
- custom strategies and native/legacy paths need separate duplication;
- unnecessary scan latency.

## Trade-off analysis

Option B is the only approach that produces complete Phase 3 observability while preserving a clean control experiment. The adapter is intentionally temporary but narrow, versioned, deterministic, and testable.

Correlation grouping is deliberately conservative. It prevents several variations of the same price hypothesis from appearing independent, without claiming that fixed group membership is statistically estimated. Phase 5 may replace static groups with validated dependence estimates.

## Security and financial safety

- Specialist modules import no executor, broker adapter, credential service, or mutable risk policy.
- The council contract includes `cannotExecute: true`.
- The API is authenticated and read-only.
- Specialist narratives remain untrusted data and cannot become instructions.
- Runtime validation rejects malformed opinions.
- Append-only storage excludes exchange credentials and authorization material.
- Brain V0 remains the sole source read by the active entry path.

## Scalability and reliability

- Opinion IDs deduplicate repeated scans of the same closed-candle snapshot.
- Database inserts are batched and use conflict-free idempotency.
- The in-memory projection is replaced each scan so removed or blocked symbols cannot retain stale current opinions.
- Council computation is linear in the number of eligible strategies.
- MarketState fingerprints avoid duplicating large candle arrays in every opinion.

## Consequences

Easier:

- Phase 4 can consume a stable set of specialist opinions;
- disagreement and abstention become first-class and replayable;
- each specialist can be measured by regime, symbol, direction, and cost sensitivity;
- individual strategies can later migrate to native opinions behind parity tests.

Harder:

- compatibility and native specialist versions must coexist temporarily;
- correlation groups require governance and later statistical validation;
- append-only opinion volume needs retention and partitioning review before large-scale deployment.

## Action items

- [x] Define MarketSpecialist and Specialist Council contracts.
- [x] Add the compatibility adapter for plans, rejections, and abstentions.
- [x] Add deterministic correlation discounting.
- [x] Add observational engine and authenticated API integration.
- [x] Add append-only, deduplicated opinion capture definitions.
- [x] Add Specialist Council UI states.
- [ ] Generate API clients from OpenAPI.
- [ ] Apply and verify the database schema in disposable PostgreSQL.
- [ ] Run full workspace and browser suites.
- [ ] Establish specialist calibration in Phase 5 before displaying calibrated quality.
- [ ] Keep the stacked PR draft until earlier phases and all gates pass.
