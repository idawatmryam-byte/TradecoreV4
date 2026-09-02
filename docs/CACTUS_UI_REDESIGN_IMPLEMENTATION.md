# Cactus AI trader workspace and Admin Console

## Status and boundary

This change is the first implementation milestone of the approved Cactus AI UI/UX redesign. It was created from `origin/main` at `e1945af8b0a5eab27647d00d62a93f9cd09de257` in the dedicated `codex/cactus-ui-redesign` branch and `D:\Awat\TradecoreV4-ui-redesign` worktree.

It does not change trading algorithms, broker commands, order semantics, deterministic risk, financial roles, mandate semantics, or Phase 13. It does not deploy, contact a provider, change credentials, or authorize Live trading.

Manual order entry remains unavailable. Pending orders remain explicitly unavailable until an authoritative projection exists. External AI providers, multiple broker accounts, and Admin mutations are not represented as working capabilities.

## Frontend architecture audit and migration

The original React/Vite trader SPA used a single eager route switch, one trader navigation containing product and operator concepts, TanStack Query plus several raw requests, Wouter, Tailwind/Radix primitives, and local-storage section selection. Tenant financial authority consists of `OWNER`, `FINANCIAL_OPERATOR`, and `VIEWER`; no platform-administrator identity existed.

The migration is deliberately additive:

| Existing surface | New location | Compatibility behavior |
|---|---|---|
| `/` | Dashboard | Redirects to `/dashboard` |
| `/portfolio`, `/trades`, `/journal`, `/stats` | Dashboard summaries and activity | Legacy deep routes remain reachable |
| `/ai-brain`, `/copilot`, `/decisions` | Dashboard Intelligence | Legacy deep routes remain reachable |
| `/copilot/:id` | Dashboard recommendation review | Canonical `/dashboard/recommendations/:id`; old route remains |
| `/autopilot`, `/execution-health`, `/restricted-live` | Dashboard account controls and future Admin split | Safety-critical legacy routes remain reachable until full parity |
| `/builder` | Strategies / Builder | Query-preserving compatibility redirect |
| `/memory` | Strategies / Performance and Evidence | Query-preserving compatibility redirect |
| `/backtest` | Backtest Lab | Same route, redesigned information architecture |
| `/account` | Settings / Profile | Query-preserving compatibility redirect |
| `/strategies`, `/settings` | Strategies and Settings hubs | Rebuilt entry surfaces |

Ordinary trader navigation now contains exactly Dashboard, Strategies, Backtest Lab, and Settings. Page modules are lazy loaded. Admin is a separate Vite bundle under `/admin` and is available only through an eligible user's profile menu; hiding the link is never an authorization boundary.

## Cactus Terminal design system

`lib/ui` contains shared low-level tokens for the trader and Admin bundles. The system is dark-first with a complete light theme, semantic Cactus green, textual and chromatic Demo/Practice/Live distinctions, tabular mono numerals, a 4px spacing foundation, restrained elevation, visible focus, reduced-motion behavior, and responsive full-screen sheets.

Critical states pair color with labels and icons. Live always says `LIVE — REAL FUNDS`. Unknown, stale, partial, and unavailable values are distinct from confirmed zero values. Sensitive mutation success is displayed only after an authoritative server response.

## Dashboard contracts and authority model

`GET /api/capabilities` is the typed visibility contract. Capabilities improve UX but do not authorize an action. `GET /api/dashboard/session` provides a bounded session snapshot with a shared observation time, context, metrics, market-data freshness, runtime, positions, activity, recommendations, alerts, performance split by environment, health, and effective AutoPilot evidence.

The mode selector separates configured experience from effective authority:

- Brain maps to the existing backend `research` mode and cannot execute.
- Co-Pilot requires explicit user approval and retains its existing revalidation, fingerprint, idempotency, and Live step-up path.
- AutoPilot selection opens authority review. It does not activate automation.
- Manual is absent because its safe backend contract is not implemented.

The main chart exposes a textual summary for assistive technology. Cactus Demo, Binance Testnet/Live, and OANDA Practice/Live are named explicitly. The first account selector milestone uses the existing single connection per market; it does not introduce an account model.

## Strategy assignments

`strategy_mode_assignments` is an additive tenant/section/strategy projection with independent Brain, Co-Pilot, and AutoPilot desired state and an optimistic-concurrency revision. Missing rows are compatibility-backfilled to all modes enabled, preserving baseline behavior.

Brain and Co-Pilot consume the desired assignment set on the next scan. AutoPilot deliberately does not. The Dashboard shows current authorized strategies separately from the requested next set, and a changed AutoPilot preference cannot edit or expand an active immutable mandate. Replacing that authority still requires the existing reviewed mandate workflow.

Built-in identities bind the engine version and strategy ID. Custom identities bind their rules and update timestamp. Master enabled state remains distinct from mode assignment.

## Admin security architecture

Platform roles are a separate model from tenant financial roles:

- `PLATFORM_ADMIN`: all platform reads plus bounded AutoPilot clearance request, second-admin approval, and revocation;
- `OPERATIONS_RISK`: operational, AI, execution, risk, audit, AutoPilot gate visibility, and authority-reducing clearance revocation;
- `SUPPORT`: overview and minimized user/access visibility;
- `AUDITOR`: read-only operational and configuration evidence without user-access visibility.

All `/api/admin/*` data routes require an authenticated user, an active platform assignment, a 15-minute same-origin password step-up cookie, an unchanged user session version, an unchanged platform access version, and the endpoint's explicit permission. Platform assignment never grants a tenant financial role, broker credential access, mandate approval, or execution authority.

The Admin Console has one deliberately narrow mutation boundary: bounded production AutoPilot platform clearance. One `PLATFORM_ADMIN` requests it, a different `PLATFORM_ADMIN` approves it, it expires within 24 hours, and either `PLATFORM_ADMIN` or `OPERATIONS_RISK` may revoke it immediately. It cannot override `AUTOPILOT_GLOBAL_SUSPENDED`, grant tenant or Live authority, alter a mandate, or bypass runtime risk checks. There are no HTTP role-management, impersonation, provider-secret, or general platform-configuration mutation endpoints. The initial `PLATFORM_ADMIN` is created with `bootstrap:platform-admin`, which requires the owner-only `DATABASE_MIGRATION_URL`, an existing non-demo username, a reason, an advisory transaction lock, an empty active-role set, and an append-only audit event.

Any broader authority-changing Admin controls remain gated on a separately reviewed contract with phishing-resistant step-up, reason, idempotency, origin/CSRF checks, append-only audit, and dual control for authority expansion. A platform operator must never inherit financial authority.

Admin operational reads expose only real projections. Missing general queues, platform-wide broker/market-data telemetry, and external AI-provider infrastructure return `NOT_PROVISIONED`, never healthy. Audit metadata recursively redacts secret-like fields and stores no secret values.

## Schema and privilege migration

The new tables are:

- `strategy_mode_assignments`;
- `platform_role_assignments`;
- `platform_access_versions`;
- `platform_audit_events`;
- `platform_autopilot_clearance_events`.

Use the existing deployment order: schema push, runtime grant capture/application, deployment-schema verification, and database-role verification. Platform role and access-version rows are owner-managed and runtime read-only. Platform audit and AutoPilot clearance evidence are runtime selectable and append-only. Strategy assignment rows use the normal tenant preference write boundary. Do not use the runtime database URL for initial role bootstrap.

Rollback is additive: keep the tables and route aliases, disable the capability/route release flag at deployment level, and return the legacy trader shell. Do not drop evidence or role tables as a rollback mechanism.

## OpenAPI and raw endpoint consolidation

The OpenAPI contract now includes the Dashboard, capabilities, strategy assignments, Admin reads/session, and the previously raw account, candles, active-position, position-close, backtest-preview, and report endpoints. React Query and Zod packages are regenerated from the contract. New implementation should consume generated contracts as individual workflows migrate; legacy raw clients can be retired incrementally after parity tests.

## Accessibility and responsive behavior

The milestone targets WCAG 2.2 AA: skip navigation, route focus management, visible focus, keyboard-operable controls, semantic alerts, chart text alternatives, non-color state encoding, reduced motion, and theme contrast. The desktop terminal uses a 12-column canvas; tablet stacks chart and intelligence controls; mobile prioritizes monitoring, alerts, Co-Pilot review, authorized pause, and protected position close. Complex configuration remains desktop-first and must say so rather than compressing into an unsafe form.

## Verification and remaining gates

Required local evidence includes generated-contract drift, TypeScript checks, production builds for both bundles and the API artifact, pure Admin permission/redaction tests, strategy authority-isolation tests, existing deterministic trading safety tests, legacy browser regressions, route/critical-state browser coverage, SQL deployment harnesses, and `git diff --check`.

Database-backed integration is required before schema deployment. Provider, testnet/practice, VPS, production, Live trading, pending-order projection, external AI providers, and manual order entry remain **NOT VERIFIED** unless separately authorized and actually exercised.
