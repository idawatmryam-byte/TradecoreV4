# Trading overview dashboard upgrade

The dashboard now follows the approved Cactus AI design: a compact workspace shell, four account summary cards, an actionable intelligence panel beside the chart, visible positions, and expandable connection evidence.

## Scope and behavior

- The shell adds Activity navigation, a 220px desktop sidebar, responsive market controls, and a light default for new users. Existing saved themes, authentication, administrator gating, and execution warnings remain in place.
- The execution banner now distinguishes real funds from Binance Testnet and OANDA Practice, matching the account header instead of labelling every broker session as real money.
- Available funds and realized daily P&L use the dashboard session. The risk summary describes data coverage; it does not turn an entry-permission status into a claim that all financial risk is clear. Account metrics, source, timestamp, and unavailable/stale reasons remain available in a keyboard-accessible dialog.
- AI activity describes actual runtime, scan, mode, recommendation, and authority state. No generated analysis, confidence, model connection, or hold decision is inserted into the product.
- Chart markets include the existing `config.pairs` field, even for accounts without trades. Supported intervals are 1m, 3m, 5m, 15m, and 1h. The chart uses validated API candles and volume, supports theme changes, and shows actual entry/stop/target lines for a single matching position. Multiple positions in the same symbol do not receive a fabricated combined level.
- Position rows use readable display rounding; Details retains full ledger values and links to the existing trade history and thesis controls. Management labels describe assigned rules, not proof of broker protection.
- Co-Pilot approval bindings, broker-sandbox AutoPilot activation, and server risk gates are preserved. Internal Demo retains its existing immediate simulated AutoPilot behavior. Read-only or unknown capabilities disable dashboard mutations.
- Closing a position still requires a separate confirmation. Emergency controls now explain that stopping the runtime stops scanning and automated management without closing positions, and require confirmation before posting the existing stop request.

## Deliberate differences from the sketch

The sketch contained illustrative values and features. Production does not expose those as real evidence. The current session API does not provide a latest AI decision or reliable unrealized position P&L, so the panel uses observed scan activity and Details marks unrealized P&L unavailable. Unsupported 4h/1d intervals and invented Live-lock/provider-connected badges are omitted. Runtime, server authority, and financial environment remain distinct.

No backend, database schema, broker configuration, execution algorithm, or dependency version was changed.

## Validation

Completed locally on Windows using the existing dependencies:

- `pnpm run typecheck` — all workspace typechecks passed.
- `pnpm --filter @workspace/api-server test` — canonical deterministic API harness passed.
- `pnpm --filter @workspace/tradecore-pro run build` — production frontend build passed.
- `pnpm --filter @workspace/tradecore-pro run test:cactus-browser` — dashboard navigation, setup, strategy selection, modes, immutable approval, sandbox activation/runtime start, metrics, position details/close, runtime confirmation, read-only behavior, chart interval/symbol/theme, empty states, and responsive checks.
- `pnpm exec playwright test artifacts/tradecore-pro/e2e/phase7-position-management.spec.ts` — six desktop/mobile tests passed.
- `pnpm --filter @workspace/tradecore-pro run test:restricted-live-browser` — all 16 assertions passed.
- `git diff --check` and formatting checks.

The repository excludes Windows native build packages. Local validation used the previously installed matching Rollup, esbuild, Tailwind Oxide, and LightningCSS bindings through command-scoped `NODE_PATH` and `ESBUILD_BINARY_PATH`; the dependency manifests and lockfile were preserved. Initial installation used the frozen lockfile with lifecycle scripts disabled to accommodate the repository's POSIX preinstall command.

Browser scenarios intercept API requests with deterministic fixtures. They validate frontend behavior and request contracts, not broker/provider integration or a deployed environment. Optional screenshots can be captured by setting `CACTUS_SCREENSHOT_DIR` before running the Cactus browser harness. The screenshots contain test data only.

No deployment, production session, real account, exchange order, credential change, or database integration was exercised. Publishing and deployment require separate authorization.
