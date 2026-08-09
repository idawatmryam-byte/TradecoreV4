# Development dependency advisory acceptance — 2026-08-09

Status: temporarily accepted for the pre-Phase-7 release gate  
Review by: 2026-11-07  
Scope owner: TradeCore engineering

`pnpm audit --prod --json` reports zero production vulnerabilities. The full
workspace audit reports 12 high, one moderate, and one low advisory, all marked
`dev: true`. They are reachable through the local/CI build, documentation, test,
and OpenAPI code-generation toolchain; none is installed in the production
dependency graph or shipped in the backend bundle.

Accepted advisories:

- High: brace-expansion (three advisories), js-yaml (two), linkify-it (one),
  fast-uri (three), PostCSS (one), and nanoid (two).
- Moderate: PostCSS source-map path disclosure.
- Low: esbuild Windows development-server arbitrary file read.

The affected tools process repository-controlled source, configuration, CSS,
and OpenAPI files in CI. CI does not accept untrusted pull-request secrets, the
VPS does not expose a development server or code-generation endpoint, and
production installs are checked independently with `pnpm audit --prod`.
Consequently, the current exposure is build-worker availability or local file
disclosure to an already authorized contributor, not a runtime trading or API
attack surface.

Compensating controls:

1. CI and deployment fail on any high/critical production advisory.
2. Code generation and builds consume only reviewed repository files.
3. No Vite/esbuild development server runs on the VPS.
4. Generated artifacts are reviewed and then compiled before deployment.
5. The acceptance expires on the review date; upgrade Orval/Vite/esbuild and
   remove this acceptance as soon as their compatible dependency trees carry
   the patched versions.

This is not acceptance of future runtime advisories. Any non-development
finding, critical finding, change in reachability, or use of attacker-supplied
OpenAPI/CSS/build input invalidates this decision immediately.
