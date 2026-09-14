# TradeCoreV4 Phase 7–13 Development Handoff

Status: source of truth for the next Codex workspace  
Prepared: 2026-08-09  
Repository: `<your-org>/TradecoreV4`  
Default and development branch: `main`  
Scope: original Phase 0–6 baseline plus the owner-approved Phase 7 authority amendment and implementation record

## 1. Purpose and authority

This document is the continuation contract for a new Codex session with no
access to the conversation that produced Phases 0–6. It records the verified
repository baseline, the authority level actually granted to each completed
phase, unfinished work, pre-Phase-7 gates, and the approved Phase 7–13 roadmap.

The next session must read this file, `AGENTS.md`, the accepted ADRs, and the
phase documents before changing code. It must inspect the implementation rather
than treating documentation as proof. It must not skip promotion gates or infer
that Research/Shadow completion grants Demo or Live authority.

The older `docs/HANDOFF.md` is not authoritative for this continuation. It still
references TradecoreV3 and an obsolete branch and contains historical deployment
assumptions. Use this document and the current root `README.md`, `AGENTS.md`,
`ARCHITECTURE.md`, `.env.example`, `ecosystem.config.cjs`, and `update.sh` instead.

## 2. Verified repository baseline

### 2.1 Remote baseline before this handoff document

- GitHub repository: `https://github.com/<your-org>/TradecoreV4`
- Visibility: private.
- Default branch: `main`.
- Remote Phase 0–6 audit head: `2df933485816f115d57de6387a37bad7acf3df2a`
  (`Fix session integration test environment`).
- Local audit head before this document: `8a804ffffba28ac83c0a86283a8acd3048863166`
  with the same message.
- Canonical pre-handoff Git tree: `aaec74637f74acf4438d8e289382f7a4815b73a7`.
- The local and remote commit identifiers differ because the audited tree was
  published through the authenticated GitHub integration after normal Git push
  authentication was unavailable. The file tree was explicitly verified as
  identical. A fresh clone of remote `main` is the clean migration path.
- Linux/PostgreSQL CI run:
  `https://github.com/<your-org>/TradecoreV4/actions/runs/31326905219`.
  Its `verify` job completed successfully: install, production dependency audit,
  full typecheck, pure harness, PostgreSQL schema application, capture grants and
  purge-function verification, database integration harness, frontend build, and
  backend build all passed.

The handoff document must be committed to remote `main` before migration. The
commit containing this file becomes the new remote handoff head; the baseline
above remains the code-state anchor because this commit changes documentation
only.

### 2.2 Fresh-clone bootstrap

Use a new directory and clone `main`; do not copy the old `.git` directory or
untracked build artifacts:

```bash
git clone https://github.com/<your-org>/TradecoreV4.git
cd TradecoreV4
git switch main
git status --short --branch
git log -1 --oneline
```

Then read:

1. `AGENTS.md`
2. `docs/PHASE_7_13_HANDOFF.md`
3. `docs/BRAIN_V0_BASELINE.md`
4. `docs/adr/ADR-001-unified-intelligence-contracts.md`
5. `docs/adr/ADR-002-observational-specialist-adapters.md`
6. `docs/phase-4-shadow-decision-council.md`
7. `docs/phase-5-evidence-learning.md`
8. `docs/phase-6-shadow-portfolio-intelligence.md`
9. `docs/adr/ADR-006-phase-6-shadow-portfolio-intelligence.md`
10. `docs/security/DEPENDENCY_RISK_ACCEPTANCE_2026-08.md`

### 2.3 Roadmap numbering warning

The repository predates the unified-brain roadmap and contains historical code
comments and a README section that use labels such as “Phase 7,” “Phase 8,” and
“Phase 10” for older trade-management and profitability work. Those labels do
not mean that unified-brain Phases 7–13 in this document have been implemented.
For all new work, “Phase 7” through “Phase 13” mean the sections in this file.

## 3. Non-negotiable architecture and safety boundaries

The remaining work continues Option C, the coordinated unified intelligence
architecture:

```text
Shared point-in-time market perception
  + specialist opinions
  + validated evidence
  + portfolio context
  + bounded AI reasoning
        -> explainable proposed action or abstention
        -> deterministic risk authority
        -> Research / Shadow / Co-Pilot / Demo / restricted Live
```

Preserve these rules:

1. Brain V0 remains the frozen control until a candidate passes predetermined
   out-of-sample and forward gates.
2. AI is advisory and cannot call a broker, expand authority, override risk, or
   invent market/evidence inputs.
3. Deterministic risk is the final veto authority.
4. Research, Shadow, Co-Pilot, Demo, and Live are distinct authority states.
5. Live actions require explicit human authorization of a bounded mandate.
6. Closed, point-in-time data and reproducible version/fingerprint lineage are
   mandatory. Stale, incomplete, contradictory, or non-finite inputs fail closed.
7. Every phase includes its API contract, persistence, UI/UX, loading/empty/
   stale/degraded/error states, tests, security review, and documentation.
8. No phase is promoted because an explanation sounds intelligent or a single
   P&L number looks good. Sample size, uncertainty, costs, drawdown, regime mix,
   calibration, and drift must be reported.
9. Existing Demo/Live behavior must not change incidentally while building a
   Research or Shadow feature.
10. Generated clients are derived from `lib/api-spec/openapi.yaml`; do not edit
    `lib/api-zod/src/generated/` or
    `lib/api-client-react/src/generated/` by hand.

## 4. Phase 0–6 completion status

“Complete” below means complete at the authority level explicitly approved for
that phase. It does not mean promoted to autonomous Demo or Live execution.

| Phase                        | Status                                                              | Implemented outcome                                                                                                                                                                        | Authority boundary                                                                                                                        |
| ---------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 0 — Baseline                 | Complete                                                            | Versioned Brain V0 manifest, deterministic fingerprints, metric and promotion contracts, rollback classes, baseline UI/status, and harness coverage                                        | Observational only; no decision or execution behavior change                                                                              |
| 1 — Unified contracts        | Complete                                                            | Versioned intelligence schemas, canonical serialization/hashing, TradePlan adapters, append-only capture definitions, OpenAPI and generated client contracts                               | Compatibility-first; Brain V0 remains the money path                                                                                      |
| 2 — Shared market perception | Complete                                                            | Immutable closed-candle `MarketState`, data-quality/freshness refusal, market overview/radar surfaces, and deterministic fixtures                                                          | Observational; no fabricated cross-symbol data and no execution authority                                                                 |
| 3 — Specialist advisers      | Complete for the approved compatibility-first milestone             | Strategies are projected through `MarketSpecialist`/`StrategyOpinion`, including abstentions, evidence, disagreement, static correlation discounting, capture, API, UI, and parity tests   | Observational compatibility adapters describe Brain V0 outcomes; native specialist replacement is not active                              |
| 4 — Shadow Decision Council  | Complete as Shadow                                                  | Deterministic-first council, explicit abstention and uncertainty, evidence-reference validation, optional provider-neutral narrative adapter, replay/capture, AI Brain UI, and tests       | Structurally `cannotExecute: true`; deterministic output only; no broker/executor import                                                  |
| 5 — Evidence learning        | Complete for Research/Shadow and approved tightening-only influence | Point-in-time evidence records, conditional cells, uncertainty, BH correction, chronological validation and embargo, lifecycle approval/rollback, audit events, UI, API, schema, and tests | Cannot originate trades, increase conviction, lower risk gates, or self-tune; activation requires exact human confirmation                |
| 6 — Portfolio intelligence   | Complete as a Shadow candidate; not promoted                        | Same-scan opportunity collection, deterministic ranking then bounded allocation, correlation/strategy/symbol/risk reservations, cash outcome, read-only API/UI, and deterministic harness  | Process-local Shadow projection only; `cannotExecute: true`; no real reservation or change to Brain V0, Demo, Co-Pilot, or Live selection |
| 7 — Thesis-aware management  | Implemented; repository validation complete, operational soak pending | Persistent thesis, deterministic state/policy, explicit single owner, append-only action audit, API/UI, Demo/testnet/practice active seam, and browser coverage                       | Active authority is opt-in and sandbox-only; real Live remains disabled and all Phase 8/11/12 promotion gates remain                      |

### 4.1 Principal completed modules

- Baseline and contracts:
  `artifacts/api-server/src/lib/intelligence/baseline.ts`,
  `canonical.ts`, `contracts.ts`, and `trade-plan-adapter.ts`.
- Market perception:
  `artifacts/api-server/src/lib/intelligence/market-state/` and
  `artifacts/tradecore-pro/src/components/market-overview.tsx`.
- Specialists:
  `artifacts/api-server/src/lib/intelligence/specialists/` and
  `artifacts/tradecore-pro/src/components/specialist-council.tsx`.
- Decision Council:
  `artifacts/api-server/src/lib/intelligence/council/`,
  `artifacts/api-server/src/routes/intelligence.ts`, and
  `artifacts/tradecore-pro/src/pages/ai-brain.tsx`.
- Evidence:
  `artifacts/api-server/src/lib/intelligence/evidence/`,
  `artifacts/api-server/src/lib/knowledge/`,
  `artifacts/api-server/src/lib/memory/`,
  `lib/db/src/schema/evidence.ts`, and the Learning & Evidence UI.
- Portfolio intelligence:
  `artifacts/api-server/src/lib/intelligence/portfolio/`,
  `artifacts/api-server/src/routes/portfolio.ts`,
  `lib/db/src/schema/intelligence.ts`, and
  `artifacts/tradecore-pro/src/pages/portfolio-intelligence.tsx`.
- Shared contracts and persistence:
  `lib/api-spec/openapi.yaml`, generated Zod/React clients, and
  `lib/db/src/schema/`.
- Verification:
  `artifacts/api-server/harness/brain-v0-baseline.test.ts`,
  `intelligence-contracts.test.ts`, `market-state.test.ts`,
  `specialists.test.ts`, `decision-council.test.ts`,
  `evidence-learning.test.ts`, `portfolio-intelligence.test.ts`, and the
  broader pure/integration suites configured in
  `artifacts/api-server/package.json`.

## 5. Unfinished work, known failures, and technical debt

This section must be reviewed before Phase 7 planning or implementation. Items
marked **BLOCKER** are required pre-Phase-7 work because the owner explicitly
placed them before Phase 7 or because they prevent a truthful safety claim.

### 5.1 Operational and validation blockers

1. **BLOCKER — the VPS no-trade incident does not have a verified root cause.**
   `docs/phase-6-shadow-portfolio-intelligence.md` records the incident as
   deferred. No repository-only test can substitute for inspecting the actual
   VPS PM2 logs, deployment output, database state, desired-running flags,
   provider authentication, configured pairs, and scan summaries.
2. **BLOCKER — real-provider smoke validation is incomplete.** The Linux CI run
   proves deterministic and database integration behavior with fixtures and
   scripted adapters. It does not prove a real Binance testnet account or OANDA
   practice account can authenticate, receive current market data, scan, place
   and protect a test order, reconcile it, and close it on the VPS.
3. **BLOCKER — simultaneous Crypto and Forex operation is verified only through
   the database integration harness.**
   `connection-management.test.ts` runs Crypto and Forex transitions concurrently
   and verifies provider-client isolation, but the equivalent real Binance
   testnet/OANDA practice soak has not been observed.
4. **BLOCKER — Demo/test environment to Live transitions are integration-tested,
   not real-provider verified.** The transition harness uses zero open positions
   and verifies fresh clients plus fail-closed reconciliation. Enabling a real
   Live environment is a sensitive action and requires the owner’s explicit
   approval, valid credentials, zero open positions, and direct observation.
5. **BLOCKER — no automated browser/E2E suite is present.** ADR checklists still
   mention browser suites, but the repository contains no Playwright/Cypress
   workflow. Critical mode labeling, approval, stale/degraded states, responsive
   behavior, and accessibility have not been browser-automated.

### 5.2 Live execution and operations debt

1. `artifacts/api-server/src/lib/execution/intentLog.ts` still documents and
   implements `openIntent()` as best-effort. It returns `null` on a database
   write failure, and `botEngine.ts` can continue to a real broker call without
   a durable intent. Phase 11 requires mandatory pre-broker intent persistence
   and fail-closed new entries. Do not describe the current intent path as
   satisfying that requirement.
2. Live startup reconciliation is partially hardened now: Live starts in
   exit-only mode, blocks new entries while broker/database/protection state is
   ambiguous, continues existing-position management, retries, and reopens the
   entry gate only after successful reconciliation. This behavior is covered by
   integration tests but still requires VPS/provider validation.
3. `LiveExecutor` has no completed global/exchange/account/section/symbol/
   strategy kill-switch authority. Its source explicitly identifies entitlement
   and kill-switch checks as future work. These belong to Phase 11.
4. Durable reconciliation of every non-terminal intent, ambiguous broker order,
   DB trade, position, and protection order is not a complete independent worker.
   Current startup reconciliation is valuable but does not satisfy the full
   Phase 11 ledger/recovery contract.
5. `update.sh` now performs a fast-forward-only update, production dependency
   audit, typecheck, pure tests, builds, schema application, restart, liveness,
   readiness/engine-resume verification, and automatic runtime rollback.
   Confirm the VPS actually invokes `update.sh`; the older
   `scripts/post-merge.sh` only installs dependencies and pushes schema.
6. The current deployment is intentionally one PM2 fork process. Multiple
   instances could duplicate orders because engine ownership is process-local.
   Do not enable PM2 cluster mode before Phase 13 leases and fencing exist.

### 5.3 Phase-specific limitations carried forward

#### Phase 3

- Specialist outputs are compatibility projections of Brain V0 plans,
  rejections, and abstentions, not independent native replacements.
- Correlation groups are static conservative metadata, not statistically
  estimated dependence.
- Specialist Council still labels specialist quality uncalibrated.
- Append-only specialist/council volume needs retention/partitioning policy
  before large-scale production.

#### Phase 4

- The reasoning provider is optional and disabled by default. Deterministic
  council decisions are implemented; an unavailable provider must remain an
  explanation-only degradation, not an execution failure.
- Council support scores are explicitly uncalibrated and must not be displayed
  as probabilities.

#### Phase 5

- Validation uses one chronological train/validation split plus embargo.
  Multi-fold purged cross-validation and untouched holdouts belong to Phase 8.
- Drift is measured and displayed, but automatic suspension thresholds belong
  to Phase 10.
- Evidence can withhold entries. Positive evidence remains descriptive and may
  not increase conviction. Bounded risk reduction still needs the approved
  portfolio/risk adapter.
- Historical outcome coverage is incomplete for some economics and path fields;
  unavailable MAE/MFE timing remains null rather than reconstructed.

#### Phase 6

- Equity and available balance currently share broker free-balance data;
  unrealized equity is not authoritative.
- Drawdown is a current-day realized-P&L proxy, not peak-to-equity drawdown.
- Liquidity uses volume, not order-book depth.
- Correlation depends on sufficient closed daily history; unknown is not zero.
- The latest portfolio projection and reservations are process-local and not
  durable or concurrency-safe.
- No real funds or broker capacity are reserved by a Shadow allocation.
- `estimatedNetR` remains null until calibrated probability/expectancy exists.
- Portfolio-level full-brain backtests, forward capture, cost/calibration/drift
  review, and explicit promotion have not occurred.

### 5.4 Repository and governance debt

- The old `docs/HANDOFF.md` is stale and must not guide a new clone.
- The root README’s historical “Phase 10” label conflicts with this roadmap’s
  numbering. Preserve behavior, but clarify numbering when that document is next
  intentionally edited.
- The full workspace dependency audit reports 12 high, one moderate, and one low
  development/build/code-generation advisory. Production dependencies have zero
  reported vulnerabilities at the accepted threshold. The temporary acceptance
  in `docs/security/DEPENDENCY_RISK_ACCEPTANCE_2026-08.md` expires 2026-11-07 and
  must be reviewed earlier if reachability or build inputs change.
- Two temporary remote branch names may remain:
  `ci/phase-0-6-audit-base` and
  `ci/phase-0-6-audit-verification`. They were verified identical to `main` and
  contain no unique work. Their deletion is repository hygiene, not a migration
  or Phase 7 blocker.
- The previous local workspace’s `origin/main` tracking ref was stale because Git
  authentication was unavailable. A fresh clone avoids carrying that state.

## 6. Mandatory gate before Phase 7 starts

The Phase 7 implementation decision is **NO-GO** until all mandatory items below
are either completed with evidence or explicitly accepted by the owner with a
documented scope and expiry. Do not weaken risk or strategy thresholds to make a
smoke test trade.

**2026-08-09 disposition:** the owner explicitly accepted deferral of the
operational items below for repository implementation and bounded
Demo/testnet/practice validation only. The deferral does not expire into or
authorize real Live. The outstanding items remain hard Live-promotion blockers
and are tracked in `docs/phase-7-promotion-report.md`.

- [ ] Clone fresh remote `main`; verify this handoff commit, clean working tree,
      Node 20+, pnpm 9+, and the expected environment template.
- [ ] On the VPS, capture `git rev-parse HEAD`, `git status`, PM2 process state and
      logs, deployment logs, `/api/healthz`, `/api/readyz`, database connectivity,
      desired-running rows for both sections, provider credential test results,
      configured pairs, monitored-market counts, and recent scan/funnel summaries.
- [ ] Diagnose and document the no-trade incident’s root cause. Prove the fix in
      the environment where the incident occurred; do not infer it from a clean CI
      run.
- [ ] Confirm the VPS schema includes non-null `users.session_version` and the
      `capture.purge_user_data(integer)` function. Confirm the runtime role has the
      intended capture grants.
- [ ] Run Crypto Demo and Binance testnet smoke checks using real current market
      data. Record mode, account, configured symbols, scan result, order/protection/
      close behavior where authorized, and reconciliation state.
- [ ] Run Forex Demo/practice smoke checks with real OANDA practice data and
      credentials. Record the same evidence.
- [ ] Run both engines simultaneously and prove one section’s start, stop,
      transition, provider client, and state do not affect the other.
- [ ] With zero open positions, test Demo/testnet/practice to Live configuration
      transitions only after explicit owner approval. Verify a fresh provider client,
      correct environment, desired-running state, and fail-closed entry reconciliation.
      No live order is required to validate a transition.
- [ ] Confirm a failed Live reconciliation keeps existing position management
      active while blocking every new-entry path, including Co-Pilot approval.
- [ ] Confirm the VPS uses the hardened `update.sh` path and test its post-restart
      health/resume check plus rollback on a controlled non-financial failure.
- [ ] Decide whether Phase 7 will remain Research/Shadow-only until the Phase 11
      intent-log, kill-switch, and reconciliation ledger requirements are complete.
      The recommended and roadmap-consistent answer is yes.
- [ ] Add or explicitly defer a browser/E2E harness for the critical Phase 7 UI
      states. The cross-phase UX definition of done expects browser regression
      evidence.

## 7. Phase dependency order

The intended sequence is:

```text
Pre-Phase-7 operational gate
  -> Phase 7 thesis-aware bounded management
  -> Phase 8 full-brain research and validation
  -> Phase 9 supervised Co-Pilot workflow
  -> Phase 10 bounded Demo Autopilot and forward soak
  -> Phase 11 hardened Live money path
  -> Phase 12 human-authorized restricted Live Autopilot
  -> Phase 13 distributed scale and ownership fencing
```

Phase 8 depends on Phase 7 because the research engine must replay management
policies. Phase 9 depends on validated decisions and revalidation semantics.
Phase 10 depends on Research, Shadow, and Co-Pilot evidence. Phase 11 must finish
before Phase 12. Phase 13 follows edge validation and safety hardening; it must
not be used to scale an unverified money path.

## 8. Phase 7 — Professional Trade Thesis and Adaptive Management

### Owner-approved authority amendment (2026-08-09)

The owner explicitly approved Phase 7 implementation with active authority in
Demo, Binance testnet, and OANDA practice environments. This supersedes the
Research/Shadow-only recommendation in Sections 6, 8, and 16 for Phase 7 only.
It does not close or waive any real-Live prerequisite.

- `fixed` keeps the existing fixed manager as the sole mutating owner.
- `phase7_shadow` keeps the fixed manager as the sole mutating owner and records
  the Phase 7 decision without changing the position.
- `phase7_active` assigns Phase 7 as the sole adaptive-management owner only in
  Demo/testnet/practice. The fixed adaptive manager does not run for that
  position; baseline stop/target/time/emergency settlement remains enforced.
- Real Live defensively resolves `phase7_active` to fixed ownership plus Shadow
  observation. Live activation remains gated by the unresolved VPS, provider,
  reconciliation, deployment, concurrency, and production-safety evidence.

The accepted architecture and rollback contract are recorded in
`docs/adr/ADR-007-phase-7-position-management-authority.md`.

### Objective

Connect entry and exit behavior through a persistent, versioned thesis so the
system knows why it entered, what invalidates the position, what path was
expected, and which bounded management actions are allowed. AI may observe and
recommend but may not widen risk or act outside deterministic policy.

### Scope

- Persist a `TradeThesis` with each accepted plan.
- Evaluate the thesis against later immutable `MarketState` snapshots.
- Produce `VALID`, `WEAKENING`, `INVALIDATED`, `TARGET_DEGRADED`, or
  `DATA_UNCERTAIN` state.
- Allow only catalogued actions: hold, reduce, move a stop to an approved level,
  apply a tested trailing policy, exit on invalidation, or freeze changes when
  data is uncertain.
- Integrate incrementally with existing fixed SL/TP, emergency exits, and trade
  management. Do not replace the safety baseline in one step.
- Add the Position Thesis UI and audit timeline.

### Relevant modules and components

- Contracts: `artifacts/api-server/src/lib/intelligence/contracts.ts`.
- New bounded domain area expected under
  `artifacts/api-server/src/lib/intelligence/position/`.
- Market updates: `artifacts/api-server/src/lib/intelligence/market-state/`.
- Entry/plan integration: `intelligence/trade-plan-adapter.ts`,
  `strategies/base.ts`, `strategies/selector.ts`, and `botEngine.ts`.
- Current management: `tradeManager.ts`, `exitManager.ts`, `exitTypes.ts`,
  `execution/trailing.ts`, `binanceOco.ts`, and the OANDA broker adapter.
- Persistence: `lib/db/src/schema/trades.ts`, `intelligence.ts`, `capture.ts`, and
  any narrowly scoped new thesis/management event schema.
- API source and generated clients: `lib/api-spec/openapi.yaml`, `lib/api-zod/`,
  and `lib/api-client-react/`.
- UI: Trades/Decisions pages, `position-chart.tsx`, `decision-timeline.tsx`, and a
  new Position Thesis card/timeline where appropriate.
- Tests: existing adaptive SL/TP, execution, live-engine, OANDA, determinism,
  market-state, and portfolio-risk harnesses.

### Dependencies on previous phases

- Phase 1 `TradeThesis`, `BrainDecision`, evidence, reason-code, and fingerprint
  contracts.
- Phase 2 point-in-time `MarketState` and freshness/data-quality refusal.
- Phase 3 specialist supporting/opposing evidence.
- Phase 4 deterministic Shadow decision lineage.
- Phase 5 approved evidence only; observational evidence cannot silently alter a
  position.
- Phase 6 portfolio risk context and bounded risk budgets.

### Implementation tasks

1. Persist a versioned `TradeThesis` for every accepted plan: context, trigger,
   invalidation, target rationale, expected path, expected duration, and permitted
   management policy.
2. Add a `PositionThesisState` evaluator under
   `artifacts/api-server/src/lib/intelligence/position/` that consumes later
   `MarketState` snapshots and emits the five approved states.
3. Define a versioned, bounded management-action catalog: hold, reduce, move stop
   to an approved level, update a tested trailing policy, exit on invalidation,
   and freeze changes under uncertain data.
4. Route every proposed action through deterministic validation proving it cannot
   increase risk beyond the approved mandate.
5. Integrate incrementally with `tradeManager.ts` and the exit path in
   `botEngine.ts`; preserve current SL/TP and emergency controls as baseline.
6. Run exit-policy ablations and walk-forward tests before any adaptive action can
   affect Demo or Live.
7. Record market evidence, source fingerprints, policy version, proposer,
   validation result, and actual action for every stop change, reduction, or exit.
8. Prevent widening stops, adding to losing positions, removing protection, or
   extending holding time beyond approved policy.
9. Add a live Position Thesis card showing the original thesis, current state,
   progress, contrary evidence, protection status, and next permitted action.
10. Add a timeline that clearly separates AI observations/recommendations,
    deterministic risk decisions, and executed management actions.
11. Require explicit approval for management-policy changes and label fixed versus
    adaptive management.
12. Update OpenAPI first, regenerate clients, add persistence/schema changes, and
    document the versioning/rollback contract.

### Acceptance criteria

- Every managed position has a reproducible thesis and permitted-policy version.
- The same position, state snapshots, and versions produce the same thesis states
  and proposed actions where deterministic behavior is expected.
- No action can increase approved maximum loss, widen a stop, remove protection,
  add to a loser, or exceed duration policy.
- Stale/missing/contradictory/non-finite data produces `DATA_UNCERTAIN` and freezes
  adaptive changes while baseline protection remains active.
- Existing fixed management remains available as control and rollback.
- Recommendation, deterministic verdict, and broker/DB action are separately
  visible and auditable.
- Demo/testnet/practice authority is available only through the explicit,
  position-pinned `phase7_active` mode approved above. Real Live adaptive
  authority is not granted by Phase 7 implementation.

### Required tests and validation

- Unit and property tests for state classification, invalidation, permitted action
  geometry, risk monotonicity, idempotency, and fingerprints.
- Deterministic simulations for false breakouts, normal pullbacks, gaps, stale
  data, volatility shocks, protection failure, and conflicting specialists.
- Crypto spot/futures and Forex/OANDA fixtures, including long and short.
- Parity tests proving inert/fixed-policy mode preserves Brain V0 behavior.
- Exit-policy ablation and walk-forward evaluation with costs, drawdown, sample
  size, and uncertainty.
- Database/API contract tests for immutable thesis and append-only management
  events.
- Browser tests for fixed/adaptive labels, stale/degraded states, thesis timeline,
  approval, keyboard use, and non-color-only status.

### Security and risk considerations

- Treat AI/specialist narratives as untrusted evidence, never executable input.
- Revalidate ownership, section, open-position identity, policy version, and
  freshness for every action.
- Use idempotency/fingerprints so retries cannot apply a stop or reduction twice.
- Never allow a management failure to remove existing protection.
- Keep Live authority disabled until Phases 8–12 gates explicitly grant it.

### Expected deliverables

- Versioned thesis/state/action contracts and evaluator.
- Persistence and append-only audit trail.
- Incremental management integration with a fixed-policy rollback.
- OpenAPI and regenerated clients.
- Position Thesis UI/timeline with complete states.
- Deterministic, integration, simulation, and browser evidence.
- Phase 7 architecture/operation document and promotion report.

## 9. Phase 8 — Scientific Research and Brain Validation

### Objective

Turn backtesting into a full-brain experiment laboratory that replays market
state, specialists, evidence, portfolio allocation, council decisions, and Phase
7 management policies under point-in-time, out-of-sample procedures.

### Scope

- Full decision-stream replay, not only strategy entry/exit calculation.
- Walk-forward, purged time-series cross-validation, embargo, untouched holdout,
  multiple-testing accounting, stress tests, attribution, and promotion reports.
- Control/candidate comparison across Brain V0, specialists, deterministic
  council, optional AI-assisted narratives, portfolio planner, and management.
- Experiment Lab UI and timestamped decision replay.

### Relevant modules and components

- `artifacts/api-server/src/lib/backtestEngine.ts`, `backtestConfig.ts`,
  `historicalData.ts`, `oandaHistoricalData.ts`, `optimizer.ts`, and
  `metrics/kernel.ts`.
- `artifacts/api-server/src/routes/backtests.ts` and `autopsy.ts`.
- All `artifacts/api-server/src/lib/intelligence/` packages, including the new
  Phase 7 position package.
- `lib/db/src/schema/backtest.ts`, `autopsy.ts`, `evidence.ts`, and
  `intelligence.ts`.
- `artifacts/tradecore-pro/src/pages/backtest.tsx` and `autopsy-panel.tsx`.
- Baseline, determinism, selection, metrics, fill, portfolio, evidence, and
  backtest harnesses.

### Dependencies on previous phases

- Frozen Phase 0 metrics/manifests and promotion policy.
- Versioned Phase 1 contracts and deterministic fingerprints.
- Phase 2–6 point-in-time perception, opinions, council, evidence, and portfolio
  decisions.
- Phase 7 thesis and management-policy replay.

### Implementation tasks

1. Extend `backtestEngine.ts` to replay versioned market states, specialist
   opinions, evidence rules, portfolio allocation, council output, and management
   policies.
2. Enforce point-in-time behavior and prohibit look-ahead in features, evidence,
   universe membership, regimes, labels, and model inputs.
3. Add walk-forward evaluation, purged time-series cross-validation, embargo
   periods, untouched holdouts, and multiple-testing accounting.
4. Persist experiment manifests containing code/config/model/data hashes and
   deterministic seeds where applicable.
5. Compare Brain V0, individual specialists, deterministic council, optional
   AI-assisted council narrative, and portfolio brain under identical costs/fills.
6. Stress fees, slippage, spread, latency, missing data, and adverse intrabar
   ordering.
7. Attribute differences to perception, selection, learning, allocation,
   execution costs, and management rather than reporting only total P&L.
8. Promote broad parameter plateaus rather than isolated optima.
9. Record rejected, waiting, observed, and expired opportunities as well as trades.
10. Redesign Backtesting as an Experiment Lab with control/candidate comparison,
    windows, uncertainty, cost stress, attribution, and promotion state.
11. Show drawdown, costs, sample size, and out-of-sample labeling with every
    headline result; make overfitting warnings prominent.
12. Add decision replay across market state, specialists, portfolio, risk,
    execution, management, and outcome.
13. Add fixed historical regression fixtures and golden decision streams.

### Acceptance criteria

- A complete brain version can be replayed from a manifest without future data.
- Control and candidate use identical point-in-time inputs, fills, costs, and risk
  assumptions.
- Results report uncertainty, sample size, costs, drawdown, regime mix, and test
  partition; no single P&L value can imply promotion.
- Attribution identifies the subsystem responsible for a difference.
- A replay that cannot reproduce its golden decision stream is invalid.
- Promotion remains a human decision against predetermined Phase 0 gates.

### Required tests and validation

- Look-ahead/leakage tests for every join and derived feature.
- Purging, embargo, holdout, and multiple-testing fixtures.
- Golden Brain V0/candidate decision-stream regression tests.
- Stress and adverse intrabar-order simulations.
- Crypto and Forex parity with identical cost/fill assumptions where applicable.
- Experiment persistence, resume, cancellation, and deterministic seed tests.
- Browser tests for experiment creation, comparison, replay, warnings, and error
  states.

### Security and risk considerations

- Research jobs must not import or reach a Live executor.
- Historical/provider inputs are untrusted and must be validated and bounded.
- Prevent user/tenant data leakage in experiment datasets and exports.
- Bound compute, concurrency, retries, and stored artifacts.
- AI summaries cannot change measurements, labels, partitions, or promotion.

### Expected deliverables

- Full-brain replay engine and versioned experiment manifest.
- Research persistence and attribution reports.
- Experiment Lab and decision replay UI.
- Leakage/stress/golden-stream suites.
- Candidate promotion or rejection report against Brain V0.

### Phase 8 implementation record (2026-08-09)

The repository now contains the Phase 8 Research implementation described in
`docs/phase-8-scientific-research.md` and
`docs/adr/ADR-008-phase-8-research-isolation-and-replay.md`.

Its authority remains Research-only. The implementation can produce
`ELIGIBLE_FOR_HUMAN_REVIEW`, but cannot promote, configure, deploy, or execute a
candidate. The current implementation-level report is
`docs/phase-8-promotion-report.md`; it remains `REMAIN_RESEARCH` until real
provider-backed experiments satisfy the predetermined gates and receive human
approval.

## 10. Phase 9 — Co-Pilot and Human Approval Workflow

### Objective

Expose the validated unified brain as a professional, human-supervised approval
workspace before granting autonomy.

### Scope

- Persist the complete brain decision, evidence, portfolio context, risk verdict,
  versions, expiry, and plan fingerprint with each recommendation.
- Revalidate all market, trigger, portfolio, risk, cost, model, and kill-switch
  conditions at approval time.
- Single-use, idempotent approval with precise refusal reasons.
- Rich Co-Pilot UI with unmistakable Demo/Live context and high-friction real-money
  confirmation.

### Relevant modules and components

- `artifacts/api-server/src/lib/execution/recommendExecutor.ts` and
  `execution/revalidate.ts`.
- `artifacts/api-server/src/lib/copilot/copilotService.ts` and
  `routes/copilot.ts`.
- `lib/db/src/schema/recommendations.ts`, `execution.ts`, `intelligence.ts`, and
  capture/evidence schemas.
- Authentication/session code in `middleware/auth.ts`, `routes/auth.ts`, and
  `routes/account.ts`; stronger step-up authentication may require a reviewed
  extension here.
- `artifacts/tradecore-pro/src/pages/copilot.tsx`,
  `copilot-workspace.tsx`, `components/copilot-summary.tsx`, and approval dialogs.
- Existing Co-Pilot, revalidation, execution, session, and connection-management
  harnesses.

### Dependencies on previous phases

- Versioned, validated decisions and fingerprints from Phases 1–4.
- Approved evidence and portfolio context from Phases 5–6.
- Thesis and bounded management policy from Phase 7.
- Phase 8 validation report for the exact candidate version.

### Implementation tasks

1. Persist the full decision/evidence/portfolio/risk/version/expiry/fingerprint
   bundle in the recommendation workflow.
2. Revalidate market freshness, trigger, portfolio, limits, execution costs,
   model health, and kill switches at approval time.
3. Make approvals single-use and idempotent; reject replay, staleness, duplicate
   execution, and mutated plans.
4. Require step-up authentication for Live financial approval once the stronger
   authentication infrastructure exists.
5. Provide Approve, Reject, Wait, Reduce Risk, and Dismiss actions. Only bounded
   changes may reuse a decision; otherwise generate a new version.
6. Record optional user rationale as observational feedback, not a truth label.
7. Redesign both Co-Pilot pages around thesis, evidence for/against, uncertainty,
   portfolio impact, risk, execution assumptions, expiry, and versions.
8. Show exactly what will happen before approval: symbol, side, quantity, maximum
   intended loss, leverage, entry behavior, stop, target, and authorization scope.
9. Make Demo versus Live unmistakable and add high-friction Live confirmation.
10. Explain approval refusal precisely when state changed.

### Acceptance criteria

- Approval cannot execute a stale, altered, replayed, duplicated, or out-of-scope
  plan.
- Current market and risk state, not the original snapshot alone, decide whether
  execution remains allowed.
- The user sees the exact bounded consequence before approval.
- User action, revalidation, risk verdict, and execution result are auditable.
- Co-Pilot remains available for decisions outside future autonomous mandates.

### Required tests and validation

- Stale decision, replay, concurrent approval, payload mutation, expired session,
  lost response, and duplicate client-order-ID tests.
- Demo and Live target separation, step-up authentication, CSRF/session, and
  account/section isolation tests.
- Broker timeout ambiguity and idempotent retry simulations.
- Browser tests for every action, refusal, accessibility state, and mobile layout.

### Security and risk considerations

- Treat approval as a financial authorization boundary.
- Bind authorization to user, section, decision ID, exact fingerprint, risk
  decision, target, expiry, and single-use nonce.
- Never infer approval from navigation, stale UI state, or a previous session.
- Avoid logging secrets or reusable authorization material.

### Expected deliverables

- Extended recommendation schema/service and approval state machine.
- Strong revalidation/idempotency boundary.
- Step-up authentication path for Live approval.
- Unified Co-Pilot workspace and complete browser/security tests.
- Auditable approval/refusal events and documentation.

### Phase 9 implementation record (2026-08-10)

The repository now contains the supervised Phase 9 implementation described in
`docs/phase-9-copilot-approval.md` and
`docs/adr/ADR-009-phase-9-copilot-authorization-boundary.md`.

Approval is a single-use authorization to attempt the existing controlled
execution path, never an instruction to bypass it. Each proposal binds an
immutable Brain V0 plan to its same-scan Shadow unified-brain evidence, market
and portfolio context, risk result, versions, target, expiry, and fingerprints.
Approval is transactionally claimed and then freshly revalidated against current
market, thesis, portfolio, exposure, risk, reconciliation, mode, target, cost,
and execution-eligibility state. Refusals and outcomes are attributable,
append-only audit events.

The Phase 8 council remains Shadow context because its current implementation
report is `REMAIN_RESEARCH`. Phase 9 does not grant Demo or Live autonomous
authority and does not satisfy Phase 10's separate promotion prerequisites.

## 11. Phase 10 — Demo Autopilot and Shadow Promotion

### Repository implementation disposition (2026-08-12)

Phase 10 is implemented as a fail-closed Demo/testnet/practice authority layer
around the existing controlled engine. The accepted boundary and operational
contract are recorded in
`docs/adr/ADR-010-phase-10-demo-autopilot-authority.md` and
`docs/phase-10-demo-autopilot.md`. This repository implementation does not
enable autonomous Live authority, promote Phase 8 Shadow output, or satisfy the
post-merge VPS/provider validation listed in the Phase 10 operations guide.

### Objective

Allow only an explicitly approved brain version to operate autonomously in Demo
after Research, Shadow, and Co-Pilot gates, using the real decision and management
flow rather than a simplified simulation path.

### Scope

- Brain-version lifecycle registry and immutable Demo mandate.
- One selected Demo version with Brain V0/candidate parallel observation.
- Monitoring, drift, suspension, controls, and frozen forward soak.
- Brain Control Center UI with permanent Demo labeling.

### Relevant modules and components

- `botEngine.ts`, `engineRegistry.ts`, `demoStatus.ts`.
- `execution/demoExecutor.ts`, `demoExit.ts`, `demoMarketData.ts`, and shared
  `exitManager.ts`/`tradeManager.ts`.
- Intelligence council/evidence/portfolio/position packages.
- `lib/db/src/schema/botConfig.ts`, `intelligence.ts`, `execution.ts`, and a
  version-registry schema.
- Bot/config/health/intelligence routes and generated clients.
- Dashboard/layout/mode-picker/autopilot confirmation UI plus a new Brain Control
  Center surface.

### Dependencies on previous phases

- Phase 8 candidate validation and predetermined promotion report.
- Phase 9 supervised approval evidence.
- Phase 7 management-policy replay and safe Demo behavior.
- Existing Demo executor parity and current dual-section isolation.

### Implementation tasks

1. Add brain-version states: `DRAFT`, `RESEARCH`, `SHADOW`, `COPILOT`,
   `DEMO_APPROVED`, `LIVE_RESTRICTED`, `SUSPENDED`, and `RETIRED`.
2. Permit Demo autonomy only for one specifically approved version and immutable
   risk mandate.
3. Use the existing Demo executor and shared exit accounting.
4. Keep Brain V0 and candidate in parallel observation where feasible, but only
   the selected Demo version may write executable Demo trades.
5. Monitor decision frequency, abstention, costs, calibration, regime mix,
   drawdown, protection, and backtest/forward drift.
6. Automatically suspend on stale data, contract failure, unavailable model
   without approved fallback, risk violation, or predetermined degradation.
7. Never auto-promote Demo to Live; require a formal report and human approval.
8. Add Brain Control Center version, stage, mandate, health, drift, suspension,
   history, and Brain V0 comparison.
9. Display a permanent Demo banner and simulated-balance source.
10. Add Pause, Resume, Return to Shadow, and Retire with confirmation/audit.
11. Produce a frozen-parameter forward-soak report.

### Acceptance criteria

- Only the exact `DEMO_APPROVED` version and mandate can create Demo trades.
- Demo uses shared decision, risk, fill, exit, accounting, and thesis paths.
- All automatic suspensions fail safe and are visible/auditable.
- Parameters remain frozen during the predefined soak.
- No code path promotes or enables Live automatically.

### Required tests and validation

- Version-state transition and authorization tests.
- Wrong/suspended/retired version refusal and immutable mandate tests.
- Demo parity, dual-section simultaneous operation, restart/resume, stale data,
  provider fallback, drift, drawdown, and protection simulations.
- Forward-soak reporting and Brain V0 comparison tests.
- Browser tests for stage labels, controls, confirmations, and degraded states.

### Security and risk considerations

- Separate simulated balance and Demo persistence from Live accounts.
- Bind every Demo action to version, mandate, decision, and risk fingerprints.
- Human approval is required for activation, version changes, and mandate changes.
- Automatic suspension may reduce authority, never expand it.

### Expected deliverables

- Brain registry, Demo mandate, and transition state machine.
- Demo Autopilot integration and suspension monitor.
- Brain Control Center UI.
- Forward-soak report and complete regression/browser evidence.

## 12. Phase 11 — Live Safety Foundation

### Objective

Harden the real-money boundary so the system can stop, reconcile, protect, audit,
and recover every financial operation before any AI brain receives restricted
Live authority.

### Scope

- Layered kill switches and degraded operating modes.
- Mandatory durable intents and idempotent broker commands.
- Full reconciliation worker and ownership/fencing metadata.
- Account/global drawdown controls, critical alerts, graceful drain, and Execution
  Health UI.
- This phase does not itself grant AI Live authorization.

### Relevant modules and components

- `execution/liveExecutor.ts`, `intentLog.ts`, `ids.ts`, `revalidate.ts`, and
  `executor.ts`.
- `botEngine.ts` startup reconciliation, `exitManager.ts`, `tradeManager.ts`, and
  Binance/OANDA broker adapters.
- `lib/db/src/schema/execution.ts`, `trades.ts`, `botConfig.ts`, and notifications.
- `opsMonitor.ts`, `startupHealth.ts`, health/bot/config routes, `index.ts`,
  `engineRegistry.ts`, `update.sh`, and `ecosystem.config.cjs`.
- Layout/status UI and a new Execution Health workspace.
- Existing live-engine, connection-management, execution, revalidation,
  schema-security, and provider-adapter harnesses.

### Dependencies on previous phases

- Stable decision/risk/version/fingerprint contracts from Phases 0–10.
- Validated revalidation and approval boundaries from Phase 9.
- Demo soak evidence from Phase 10.
- Current partial exit-only startup reconciliation is a starting point, not the
  completed Phase 11 design.

### Implementation tasks

1. Add global, exchange, market, symbol, strategy/model, user, section, and
   Autopilot kill switches checked synchronously inside Live execution.
2. Make Live intent persistence mandatory before the broker call; fail closed for
   new entries if it cannot be recorded.
3. Build a reconciliation worker for non-terminal intents, broker orders,
   positions, DB trades, and protection using client-order and broker-trade IDs.
4. Add no-new-entry, exit-only, maintenance, and protection-degraded modes.
5. Block new entries while reconciliation is incomplete or any existing position
   has unresolved protection drift.
6. Bind broker commands to decision ID, risk decision ID, plan fingerprint,
   ownership generation, and brain version; make commands idempotent.
7. Add global and account drawdown controls beyond the daily breaker.
8. Add structured metrics and critical alerts for unprotected positions,
   ambiguous orders, mismatches, stale data, and kill switches.
9. Add graceful shutdown/deployment drain: stop new entries while protection and
   in-flight operations complete.
10. Add Execution Health for connectivity, reconciliation, protection, switches,
    degraded modes, and incidents.
11. Add a persistent Live status strip with version, authorization, risk used,
    drawdown, and switch state.
12. Add role-checked, audited Stop New Trades and Exit-Only controls with explicit
    confirmation.
13. Simulate timeouts, partial fills, duplicate IDs, protection failure, DB
    failure, process death, and manual broker intervention.

### Acceptance criteria

- No Live entry reaches a broker without a durable, unique, version-bound intent.
- Ambiguity blocks new entries and preserves/reduces existing exposure.
- Every non-terminal financial operation can be reconciled or escalated without
  guessing.
- Kill switches are synchronous at the Live boundary and cannot be bypassed by
  scans, Co-Pilot, retries, or stale workers.
- Shutdown/deploy does not abandon protection or duplicate execution.
- Execution Health and alerts expose actionable state.
- Completion does not grant an AI brain Live permission.

### Required tests and validation

- Database failure before intent, timeout after possible fill, retry, partial
  fill, duplicate ID, process-death, and protection-failure simulations.
- Binance spot/futures and OANDA reconciliation fixtures, including manual broker
  changes and untracked positions.
- Kill-switch scope/precedence, drawdown, exit-only, and graceful-drain tests.
- Restart and multi-attempt idempotency tests.
- Authorized testnet/practice chaos tests before any real-money consideration.
- Browser/security tests for status, emergency controls, roles, confirmation, and
  audit history.

### Security and risk considerations

- This is the primary financial security boundary; fail closed for entries.
- Apply least privilege and step-up authorization to emergency/risk controls.
- Protect intent and audit integrity; never store broker secrets in events.
- Preserve exit capability when entry authority is revoked.
- Human approval is required before deployments or live-control changes.

### Expected deliverables

- Kill-switch and operating-mode framework.
- Mandatory intent ledger and reconciliation worker.
- Idempotent, version/fingerprint-bound Live commands.
- Drawdown controls, metrics, alerts, and graceful drain.
- Execution Health/status/emergency UI.
- Broker failure/chaos evidence and Live safety report.

## 13. Phase 12 — Restricted Live Autopilot

### Objective

Permit one validated brain version to execute real trades only inside an explicit,
revocable, time-bounded human mandate. This is not unrestricted autonomy.

### Scope

- Versioned `TradingMandate` and step-up human authorization.
- Conservative canary allocation and automatic suspension.
- Co-Pilot fallback outside the mandate.
- Live-vs-Demo/backtest comparison and high-friction mandate UI.

### Relevant modules and components

- Brain-version registry and Demo mandate from Phase 10.
- Live safety boundary from Phase 11.
- Intelligence contracts, portfolio planner, risk modules, and decision council.
- Bot/config/account/auth/Co-Pilot routes and schemas.
- A new mandate domain/schema/API plus mandate builder/control UI.
- Capture, execution, trade, metrics, notifications, and audit facilities.

### Dependencies on previous phases

- Passed Phase 8 validation and Phase 10 frozen Demo soak.
- Phase 9 approval/revalidation and step-up authentication.
- Complete Phase 11 safety/reconciliation/kill-switch gate.
- Explicit owner authorization for an exact version and mandate.

### Implementation tasks

1. Define a versioned `TradingMandate`: brain version, accounts, exchanges,
   symbols, strategies, per-trade risk, leverage, daily/weekly/monthly loss,
   drawdown, exposure, valid hours, expiry, and fallback mode.
2. Require explicit human approval and step-up authentication to create, expand,
   renew, or reactivate a mandate.
3. Ensure the brain cannot modify its mandate and can operate only inside it.
4. Begin with very small risk, liquid symbols, conservative leverage, and one
   champion version.
5. Use canary allocation and predetermined automatic suspension thresholds.
6. Route decisions outside the mandate to Co-Pilot rather than expanding scope.
7. Compare Live fills, costs, decisions, and outcomes with expected Demo/backtest.
8. Require human review before allocation increase or version promotion.
9. Add a mandate builder showing maximum possible financial exposure in plain
   language before authorization.
10. Show usage, remaining budget, expiry, restrictions, and recent autonomous
    decisions.
11. Make version changes and risk increases high-friction, with old/new diff.
12. Prove expired, revoked, altered, or out-of-scope mandates cannot execute.

### Acceptance criteria

- Every autonomous Live action is inside an active exact-version mandate.
- Expiry, revocation, suspension, version mismatch, or limit breach blocks new
  entries synchronously.
- The brain cannot create or expand authority.
- Out-of-scope opportunities become supervised Co-Pilot decisions.
- Risk increases/version changes require explicit step-up human review.
- Live behavior is continuously compared with expected Demo/backtest behavior.

### Required tests and validation

- Mandate canonicalization, fingerprint, signature/authorization, expiry,
  revocation, scope, concurrency, and replay tests.
- Boundary tests for every numeric and categorical limit.
- Canary/suspension and Co-Pilot fallback tests.
- Testnet/practice soak of the complete restricted path before any real-money
  authorization.
- Browser tests for exposure explanation, old/new comparison, step-up approval,
  revocation, expiry, and emergency suspension.

### Security and risk considerations

- Mandates are financial authorization records: immutable, auditable, least
  privilege, exact-version, and time bounded.
- Never accept client-computed exposure or scope as authoritative.
- Use server-side current-state revalidation at every command.
- Allocation increases are sensitive external actions requiring human approval.

### Expected deliverables

- TradingMandate contract, schema, lifecycle, and authorization service.
- Restricted Live integration with Co-Pilot fallback.
- Mandate builder/status/audit UI.
- Canary and suspension monitoring.
- Security, testnet/practice, and explicit authorization evidence.

### Phase 12 implementation record (2026-08-24)

- Added canonical immutable `TradingMandate` revisions, lifecycle/usage projections,
  append-only authorization/lifecycle/decision evidence, database constraints, and
  bounded runtime grants.
- Added role/origin/session/step-up API lifecycle, authorization replay protection,
  one-active-mandate concurrency control, server-derived opaque accounts, and
  server-authoritative financial usage.
- Added the mandate gate and durable decision claim to the existing Live path,
  with a second locked check at `LiveExecutor`, Phase 11 command identity, mandatory
  intent linkage, deterministic suspension/revocation ordering, and unknown-outcome
  reconciliation semantics.
- Added valid scope-only Co-Pilot fallback, canary/threshold suspension, execution
  telemetry, operator UI, deterministic/integration/browser harnesses, ADR-011, and
  the operator/security guide in `docs/phase-12-restricted-live-autopilot.md`.
- Repository implementation does not deploy or activate Restricted Live authority.
  Database-backed, testnet/practice, VPS/provider, and real-money evidence remain
  separate and must be reported only when the corresponding checks actually run.

## 14. Phase 13 — Scalable Intelligence Platform

### Objective

Scale the validated system from one in-process owner to many users and workers
without duplicate decisions/orders, lost auditability, or cross-tenant exposure.

### Scope

- Separate API, perception, intelligence, execution, reconciliation, research,
  and learning workloads.
- Distributed leases with generation fencing.
- Durable idempotent jobs/events and shared market data.
- Tenant isolation, quotas, horizontal scaling, draining, failover, and recovery.
- User-facing subsystem health without exposing infrastructure noise.

### Relevant modules and components

- Current single-process `engineRegistry.ts`, `botEngine.ts`, `index.ts`,
  `startupHealth.ts`, and `ecosystem.config.cjs`.
- Market-data providers and historical/current data builders.
- Intelligence orchestration and all persistence schemas.
- Execution/reconciliation ledger and ownership metadata from Phase 11.
- API middleware/auth/section boundaries and operations/health routes.
- CI, deployment, observability, and new worker/job infrastructure.

### Dependencies on previous phases

- Validated edge behavior through Phases 7–12.
- Idempotent execution, reconciliation, and ownership-generation binding from
  Phase 11.
- Exact brain/mandate authority from Phases 10–12.
- Phase 13 must not begin by turning PM2 `instances` above one; fencing comes
  first.

### Implementation tasks

1. Separate API requests from market-state generation, intelligence evaluation,
   execution, reconciliation, backtesting, and learning jobs.
2. Add distributed engine/brain leases with owner, generation, heartbeat, and
   expiry per user and section.
3. Bind every execution command to the current lease generation so stale workers
   cannot trade.
4. Add durable jobs/events with idempotent consumers, bounded retries,
   dead-letter handling, and trace correlation.
5. Build shared rate-aware market data so users do not duplicate identical
   provider requests.
6. Separate hot operational projections from append-only audit events and large
   research datasets.
7. Enforce organization-safe tenancy, authorization, quotas, and per-user compute
   accounting.
8. Add horizontal scaling, controlled drain, failover, and disaster recovery
   without two execution owners.
9. Show market-data, intelligence, risk, execution, and learning health.
10. Keep normal workflows simple while exposing actionable degradation.
11. Test load, failover, lease loss, duplicates, stale owners, and recovery.

### Acceptance criteria

- At most one valid execution owner exists for each user/section/generation.
- A stale or partitioned worker cannot submit a broker command.
- Every job/event is idempotent, traceable, retry-bounded, and recoverable.
- Shared market data preserves point-in-time semantics and provider limits.
- Tenant data, credentials, budgets, and authority cannot cross boundaries.
- Draining/failover does not duplicate decisions or abandon position protection.
- Disaster recovery restores auditable state before entry authority resumes.

### Required tests and validation

- Lease acquisition/renewal/expiry/fencing tests under clock and network failure.
- Duplicate delivery, out-of-order event, poison message, dead-letter, and replay
  tests.
- Multi-worker load tests with assertions for zero duplicate orders.
- Tenant isolation and authorization tests.
- Market-data rate-limit/cache/freshness tests.
- Deployment drain, regional/process failover, backup restore, and disaster
  recovery exercises.
- Browser tests for subsystem health and actionable degradation.

### Security and risk considerations

- Leases require fencing tokens, not heartbeats alone.
- Event payloads must exclude secrets and enforce tenant/account scope.
- Encrypt credentials and sensitive data at rest and in transit; minimize worker
  access.
- Bound retries so ambiguity never becomes duplicate financial execution.
- New infrastructure does not expand a mandate or bypass human approval.

### Expected deliverables

- Worker boundaries and deployment topology.
- Lease/fencing service and ownership-bound commands.
- Durable event/job infrastructure and shared market-data service.
- Tenant/quota/observability controls.
- Load/failover/recovery evidence and production runbooks.

## 15. Cross-phase definition of done

Every remaining phase must satisfy all applicable items:

1. State the user question, supported decision, and consequence of
   misunderstanding the feature.
2. Update OpenAPI first and regenerate frontend/backend validators and hooks.
3. Provide loading, empty, unavailable, stale, degraded, error, and permission
   states.
4. Visually and semantically separate facts, estimates, opinions, AI reasoning,
   risk decisions, recommendations, and executed actions.
5. Display timestamps, freshness, version/fingerprint, uncertainty, and sample
   size where material.
6. Keep Research, Shadow, Co-Pilot, Demo, and Live unmistakable on desktop and
   mobile.
7. Meet keyboard, focus, contrast, screen-reader, reduced-motion, and non-color
   status requirements.
8. Add unit, contract, deterministic, leakage, integration, adversarial,
   simulation, browser, and regression coverage proportional to financial risk.
9. Preserve Crypto/Forex isolation and simultaneous-operation coverage.
10. Report unverified financial behavior as unverified. Typecheck/build success is
    not broker validation.
11. Document rollback/suspension and retain Brain V0 or the prior safe policy.
12. Require explicit owner approval before deployment, Live configuration,
    financial authorization, risk increase, data deletion, or other sensitive
    action.

## 16. Recommended first action in the new workspace

Do not begin Phase 7 immediately. First execute the Section 6 gate and produce a
short, evidence-linked operational closure report. If the VPS/provider checks
cannot be completed, Phase 7 may be designed or tested only in Research/Shadow
after the owner explicitly accepts the deferral; it must receive no Demo or Live
management authority.

Once the gate is closed, start Phase 7 with a small architecture review of the
existing `TradeThesis` contract, `tradeManager.ts`, `exitManager.ts`,
`botEngine.ts`, persistence model, and Crypto/Forex protection semantics. Obtain
approval before changing those financial boundaries.
