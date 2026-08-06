# Brain V0 Control Baseline

Status: Phase 0 contract  
Control commit: `07cd8b10fa9d102a4ad99e1534662a3a0a1ee1ef`  
Brain version: `brain-v0`

## Decision

The existing engine is the frozen control. Phase 0 adds measurement, identity, and promotion governance only. It does not change strategy selection, signal thresholds, position sizing, risk checks, order routing, exits, Demo behavior, or Live behavior.

This is deliberate: a candidate brain cannot be judged honestly if the control changes while it is being measured.

## Current Brain V0 pipeline

```text
Closed market candles
  → multi-timeframe SignalRow and regime
  → StrategySelector
  → ranked TradePlan or reasoned rejection
  → centralized cost-aware reward:risk floor
  → engine portfolio and risk gates
  → TradeExecutor fork
      ├─ ResearchExecutor: records no order
      ├─ RecommendExecutor: creates an expiring Co-Pilot recommendation
      ├─ DemoExecutor: simulated fill and accounting
      └─ LiveExecutor: existing broker money path
  → ExitManager / TradeManager
  → decision, capture, trade, and analysis records
```

The principal control-path sources are:

- `artifacts/api-server/src/lib/botEngine.ts`: orchestration, state, risk gates, executor selection, and money-path host integration.
- `artifacts/api-server/src/lib/strategies/selector.ts`: strategy dispatch, legacy compatibility, ranking, and the centralized net reward:risk floor.
- `artifacts/api-server/src/lib/execution/executor.ts`: the single post-plan execution boundary.
- `artifacts/api-server/src/lib/execution/liveExecutor.ts`, `demoExecutor.ts`, and `recommendExecutor.ts`: target-specific action.
- `artifacts/api-server/src/lib/metrics/kernel.ts`: canonical performance calculations.
- `artifacts/api-server/src/lib/backtestEngine.ts`: historical replay using shared strategy behavior and cost assumptions.

## Baseline manifest

Every control or candidate evaluation must carry a `BrainV0BaselineManifest` from `artifacts/api-server/src/lib/intelligence/baseline.ts`.

The manifest pins:

1. Git commit.
2. Strategy catalog and strategy-configuration hash.
3. Risk-policy version and risk-configuration hash.
4. Market-data provider, market type, exact symbol universe, candle ranges, and feature version.
5. Fee and slippage model versions.
6. Execution target and fill-model version.

Symbols and candle ranges are canonicalized before hashing. Equivalent inputs therefore produce the same manifest fingerprint regardless of input ordering. Secrets, account identifiers, API keys, and credential material must never enter a manifest.

A production capture job added in a later phase must compute configuration and universe hashes from normalized, validated values and persist the manifest beside the experiment or decision stream. Phase 0 defines the contract; it does not add an unreviewed write to the financial path.

## Metric contract

The existing metrics kernel remains the calculation source of truth. `BASELINE_METRICS` defines the semantic contract and the context the UI and reports must show.

Every headline result must include sample size and evaluation period. Estimates must include an uncertainty interval where the metric supports one.

Gross P&L, costs, and net P&L are separate fields:

```text
net P&L = gross P&L - fees - spread - slippage - financing
```

Required evaluation metrics are net expectancy in R, profit factor, maximum drawdown, expected shortfall, average win/loss in R, turnover, cost ratio, calibration error, abstention rate, regime stability, and forward/backtest drift.

The profit-factor no-loss sentinel retained by the current metrics kernel is a compatibility representation, not proof of infinite or guaranteed performance. Reports must display the underlying win/loss counts.

## Minimum evidence and uncertainty

The machine-readable promotion policy contains initial governance floors. These are minimums, not automatic approval rules and not a profitability guarantee.

| Stage | Eligible decisions | Closed/hypothetical trades | Calendar days | Human approval |
|---|---:|---:|---:|---|
| Research | 0 | 0 | 0 | Required |
| Shadow | 200 | 50 | 28 | Required |
| Co-Pilot | 500 | 100 | 56 | Required |
| Demo | 1,000 | 200 | 84 | Required |
| Restricted Live | 2,000 | 400 | 112 | Required |

A stage may require more evidence when outcomes are highly correlated, concentrated in one regime, or too sparse for a stable interval. Counting repeated evaluations of the same unchanged snapshot as independent evidence is prohibited.

Promotion compares a candidate with Brain V0 on identical point-in-time inputs, costs, fills, and risk assumptions. A candidate must be non-inferior within a pre-approved statistical margin and must not trade a materially different regime mix without a separately reported comparison.

## Promotion authority

Promotion never occurs from a single P&L number. All stages require explicit human approval.

- Research requires deterministic replay, valid manifests, leakage controls, and complete cost/sample reporting.
- Shadow requires parallel comparison with Brain V0 and no contract or risk-policy violation.
- Co-Pilot requires calibrated abstention and expiring, non-executable recommendations.
- Demo requires approval revalidation, idempotency, forward fill/cost parity, and a frozen soak window.
- Restricted Live additionally requires reconciliation, protection, kill switches, recovery tests, and a revocable time-bounded mandate.

Restricted Live is not unrestricted autonomy. Brain versions cannot expand their own authority.

## Rollback and suspension

Immediate suspension conditions are:

- invalid contract or unsupported payload;
- stale, missing, contradictory, or non-finite required data;
- deterministic risk-policy violation;
- ambiguous order, position, or protection state.

Threshold conditions cover drawdown, model/calibration drift, regime drift, and execution-cost/fill drift. The approved stage or trading mandate owns the numeric thresholds. Crossing a threshold returns the candidate to the last safe stage and opens an auditable investigation; it does not trigger self-modification.

When execution is ambiguous, stop new entries, preserve or reduce exposure, reconcile broker and database state, and require human review before resuming.

## Replay procedure

1. Select a manifest and verify its fingerprint.
2. Restore the pinned code, strategy configuration, risk configuration, symbol universe, feature version, and cost/fill models.
3. Load only the manifest's half-open candle intervals using closed point-in-time data.
4. Replay Brain V0 and the candidate over identical snapshots.
5. Record every decision, rejection, abstention, expiry, and execution result.
6. Compute metrics through the canonical kernel and attach samples, costs, uncertainty, and regime attribution.
7. Compare against the predetermined promotion gates.
8. Preserve the immutable inputs, fingerprints, results, and reviewer decision.

A replay that cannot reproduce its decision stream is invalid and cannot support promotion.

## UI contract for Phase 0

Dashboard and Decisions show a read-only intelligence strip with:

- `Brain V0`;
- `Control`;
- baseline-contract status;
- the current operating mode derived from existing configuration.

The strip is intentionally observational. It cannot start an engine, change a risk limit, approve a trade, or switch an execution target.

All future performance UI must present gross P&L, costs, net P&L, sample size, period, and uncertainty together where applicable.

## Security and operational impact

Phase 0 introduces no external call, broker permission, database write, secret handling, or execution dependency. The baseline module is pure except for local SHA-256 hashing. Invalid manifests fail closed.

The fixed control commit is public metadata inside this private repository; it contains no credential material.

## Definition of done

Phase 0 is complete when:

- the manifest validates and hashes deterministically;
- metric semantics, sample floors, promotion gates, and rollback classes are versioned and tested;
- the control pipeline is documented;
- Dashboard and Decisions identify Brain V0 and the operating mode;
- the complete existing test suite and typecheck pass;
- a reviewer confirms that no Demo or Live decision behavior changed.
