# Repository Guidelines

## Project Structure & Module Organization

This is a pnpm TypeScript monorepo. `artifacts/api-server/` contains the Express API, trading and backtest engines, routes, middleware, and strategies; its tests live in `harness/`. `artifacts/tradecore-pro/` is the React/Vite dashboard, organized under `src/`. Shared packages live in `lib/`: database schema (`db`), OpenAPI contract (`api-spec`), and generated validators/hooks (`api-zod`, `api-client-react`). Do not hand-edit generated packages. Utilities and SQL are in `scripts/`; documentation is in `docs/` and `ARCHITECTURE.md`.

## Build, Test, and Development Commands

Use pnpm 9+ with Node.js 20+; the preinstall guard rejects npm and Yarn.

- `pnpm install` installs all workspace dependencies.
- `pnpm run typecheck` checks shared libraries and every artifact.
- `pnpm run build` type-checks, then builds all packages that define a build script.
- `pnpm --filter @workspace/tradecore-pro run dev` starts the Vite UI.
- `pnpm --filter @workspace/api-server run dev` builds and starts the API.
- `pnpm --filter @workspace/api-server test` runs the deterministic harness suite.
- `pnpm --filter @workspace/api-server test:integration` runs tests requiring services or credentials.
- `pnpm --filter @workspace/db run push` applies the Drizzle schema to PostgreSQL.

## Coding Style & Naming Conventions

Use TypeScript with strict typing and two-space indentation. Follow existing module style: `camelCase` for functions and variables, `PascalCase` for React components and types, and descriptive kebab-case filenames for strategies. Keep routes thin and domain logic in `src/lib/`. Prettier 3 is available; format touched files before review. Update the OpenAPI source first when changing contracts, then regenerate dependent clients and schemas.

## Testing Guidelines

Backend tests are standalone `tsx` programs named `*.test.ts` in `harness/`. Add focused regression coverage beside related harness tests and keep fixtures deterministic. Run `test` plus `typecheck` for normal changes; run `test:integration` only with the documented database/broker setup. Preserve live/backtest behavioral parity when modifying strategies, sizing, fills, or exits.

## Commit & Pull Request Guidelines

Recent commits use concise, imperative subjects, optionally ending with an issue number, such as `Store confidence and surface the signal funnel (#22)`. Keep commits scoped. PRs should explain the user-visible effect, risk implications, validation commands, and linked issue. Include screenshots for dashboard changes and harness evidence for engine changes.

## Security & Configuration

Copy `.env.example` to `.env`; never commit secrets or broker credentials. Start with Binance testnet, OANDA practice, or built-in demo execution. Do not weaken `pnpm-workspace.yaml` supply-chain protections. Treat credential encryption, authentication, order execution, and risk gates as security-sensitive code requiring explicit regression tests.

## Engineering Mission & Priorities

Build TradeCore as a production-grade quantitative platform that may manage real capital for thousands of continuously active users. Prioritize, in order: correctness, risk management, security, reliability, auditability, maintainability, extensibility, scalability, performance, and developer experience. Never trade correctness or safety for convenience or profitability.

Keep boundaries modular, deterministic, observable, testable, secure by default, event-driven where useful, horizontally scalable, and vendor-independent where practical. Isolate business logic from exchanges, databases, AI providers, and UI frameworks. Prefer clean interfaces and the smallest safe change; avoid premature microservices, unnecessary abstractions, unrelated refactors, and compatibility breaks.

## Trading, Risk & AI Safety

Assume every decision can affect real money. Keep live trading, paper trading, backtesting, historical analysis, and simulation explicitly separated. Never fabricate market data, prices, orders, fills, confidence, win rates, profitability, metrics, or backtest results; report unavailable data plainly.

Before every order, deterministically validate position size, account and portfolio exposure, daily loss and drawdown limits, correlation, stop loss, take profit, liquidation distance, exchange constraints, slippage, and fees. Fail safely. Strategies must be deterministic, explainable, measurable, backtestable, versioned, and have documented parameters. Explain each strategy change's rationale, expected impact, risks, and validation; prefer walk-forward testing and never optimize against one dataset.

AI output is advisory. Separate analysis, signals, explanation, risk validation, execution, and monitoring. AI may not override safeguards or exchange constraints, invent data, conceal uncertainty, or perform privileged actions without authorization.

## Security & Human Approval

Apply least privilege, validate external input, and treat APIs as untrusted. Defend against prompt and data injection, broken access control, SSRF, path traversal, replay, unsafe deserialization, supply-chain compromise, and secret leakage. Load secrets only from environment variables or secret management; never expose or hardcode keys, tokens, or credentials.

Obtain explicit human approval before live trading, deployments, exchange configuration changes, risk-parameter changes, account changes, data deletion, or irreversible actions. Never perform sensitive operations silently.

## Change Workflow & Production Standards

Before implementation, inspect source code rather than trusting documentation alone. Understand architecture and dependencies; assess side effects, security, trading risk, performance, scalability, and maintainability. Explain material trade-offs and wait for approval before major architectural changes.

Production implementations should include applicable input validation, error handling, structured and audit logging, configuration checks, bounded retries, timeouts, idempotency, tests, and operational documentation. Do not ship placeholder logic, fake production paths, silent failures, hidden side effects, hardcoded operational values, or TODO-only production behavior. Favor SOLID, DRY, single-purpose functions, explicit interfaces, consistent naming, and readable code. Measure before optimizing latency, memory, API traffic, or concurrency.

For research decisions, compare alternatives, trade-offs, and risks, then recommend one with reasons; avoid hype-driven choices. Document accepted technical debt with its reason, risk, scope, and exit strategy.

## Verification & Completion Reports

Before claiming success, run applicable unit, integration, regression, risk-validation, exchange-compatibility, and error-path tests. If a check cannot run, say so and do not describe the behavior as verified. Completion summaries must state what changed and why, files modified, tests and results, remaining risks, and unverified assumptions.

Before implementing a feature, ask whether it improves reliability, security, correctness, risk management, maintainability, scalability, or auditability. Challenge proposals that do not.
