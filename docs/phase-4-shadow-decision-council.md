# Phase 4 — Shadow Decision Council

Status: Accepted for Shadow implementation  
Date: 2026-08-07

## Decision

TradeCore will introduce a deterministic-first Decision Council beside Brain V0. It consumes the same closed-candle `MarketState`, Phase 3 specialist snapshot, Brain V0 candidate plans, engine cost model, explicitly incomplete portfolio context, and only approved historical evidence. Phase 4 does not change the selected plan or any execution behavior.

The council emits a versioned `BrainDecision` with explicit abstention, uncertainty, expiry, evidence for and against, a reproducible fingerprint, and a replay bundle. The engine publishes these records to a read-only AI Brain surface and append-only capture tables.

## Safety boundary

The council package imports no broker, executor, risk approval, `ExecutionCommand`, credentials, or order API. `DecisionCouncil.evaluate()` returns a `ShadowCouncilRun` whose `mode` is `shadow` and whose `cannotExecute` field is the literal `true`. The call is fire-and-forget from the live scan so provider latency or failure cannot block or change Brain V0.

Only the deterministic aggregator can select the Shadow action and candidate plan. An optional provider-neutral reasoning adapter may summarize and challenge the result, but its schema contains no action, order, quantity, stop, target, or tool-call field. Its output is stored separately and cannot mutate the decision.

## Deterministic rules

1. Correlation-discounted specialist strength is separated into long and short scores.
2. Material disagreement forces `OBSERVE`.
3. All abstentions force `OBSERVE`.
4. A spot short candidate is `REJECT`.
5. Round-trip fees and slippage are measured against the proposed target move. Costs meeting or exceeding that move force `REJECT`.
6. Remaining support is multiplied by dominant share, average effective strength, regime suitability, and the cost penalty.
7. A score of at least 0.55 produces a Shadow `ENTER_NOW` candidate; at least 0.30 produces `WAIT_FOR_TRIGGER`; otherwise the council observes.

These values are versioned configuration, not claims of profitability or calibrated probabilities.

## AI reasoning controls

- Provider interface is vendor-independent and disabled by default.
- Evidence is passed as bounded, sanitized, explicitly untrusted structured data.
- Provider claims must cite known evidence IDs; unknown references are discarded and recorded.
- Calls have an abortable timeout, at most one retry by default, and a circuit breaker after repeated failures.
- Provider-reported model version, latency, token use, and cost are captured. Unknown accounting remains `null`.
- Invalid, timed-out, unavailable, or circuit-open providers fall back to the unchanged deterministic result.
- Identical council inputs are memoized to avoid repeated provider calls and inconsistent narratives for one snapshot.

## Data model

`capture.brain_decisions` stores the validated decision and evidence references. `capture.shadow_council_runs` stores deterministic assessment, Brain V0 comparison, reasoning/accounting, and the replay bundle. All records are append-only.

Deterministic public-market identifiers are tenant-scoped in unique constraints. A globally unique opinion or decision ID would incorrectly drop the second user who observes the same public snapshot.

## UI/UX

The AI Brain page permanently states **Shadow — cannot execute**. It presents:

- candidate action and the reason for action or abstention;
- uncertainty as an uncalibrated support score;
- supporting and opposing evidence;
- Brain V0 and candidate comparison on the same snapshot;
- optional reasoning-provider status and accounting;
- an expandable replay of market state, specialists, costs, and known limitations;
- loading, empty, stale, and error states.

## Rejected alternatives

- **LLM directly returns a trade plan:** rejected because unsupported claims could reach the money path and outputs are not reproducible.
- **AI output changes the deterministic decision:** rejected because it makes provider availability and prompt behavior financially authoritative.
- **Blocking the scan on AI:** rejected because an external provider must not delay the existing control engine.
- **Faking portfolio or memory context:** rejected. Unknown values remain explicit until Phases 5 and 6 provide validated evidence and portfolio intelligence.

## Promotion

Phase 4 remains Shadow-only. Promotion requires out-of-sample evaluation against the frozen Brain V0 measurement rules. No performance result, explanation quality, or provider confidence can automatically grant execution authority.

