# TradeCore Pro — working agreement

## Pull requests are mandatory

**Every code change ships as a pull request. No exceptions, no direct pushes
to `main`.**

Concretely, for any change — a feature, a fix, a doc edit, a one-line tweak:

1. Work on a branch (the session's designated branch, or a new one off `main`).
2. Commit with a message that explains *why*, not just what.
3. Push the branch.
4. **Open a PR against `main`** and report its URL.

Do not wait to be asked. A change that is pushed but has no PR is unfinished
work. If a PR for the branch already exists, push to it and say so rather than
opening a second one.

`update.sh` on the VPS pulls `origin/main` with `--ff-only`, so nothing reaches
production until a PR is merged. That is the intended shape: the PR is the
deploy gate, not a formality.

## Before opening the PR

Run what CI runs, so review starts from a green branch:

```
pnpm run typecheck
pnpm --filter @workspace/api-server run test          # pure harness
PORT=8090 BASE_PATH=/ pnpm --filter @workspace/tradecore-pro run build
PORT=8090 pnpm --filter @workspace/tradecore-admin run build
pnpm --filter @workspace/api-server run build
```

`pnpm --filter @workspace/api-server run test:integration` needs a live
Postgres (`DATABASE_URL`). If the environment has no database, say so in the
PR rather than implying it passed — CI will run it.

## Standing project rules

These predate this file and still hold:

- **Contract-first.** `lib/api-spec/openapi.yaml` is the source of truth.
  Regenerate with `pnpm --filter @workspace/api-spec exec orval`. Never
  hand-write frontend hooks or response shapes.
- **Drizzle-first.** `lib/db/src/schema/*` is the schema source of truth,
  applied with `pnpm --filter @workspace/db run push`. No raw `ALTER TABLE`.
- **Validate before deploy.** Alpha changes get a harness comparison
  (`harness/run.ts --label before` → change → `--label after` →
  `compare.ts`). This is the project's core discipline — see
  `docs/HANDOFF.md` §8.
- **No fabricated numbers.** Any statistic below its sample gate renders
  "insufficient history", never a number.
- **No PM2 clustering.** Two instances place duplicate live orders;
  `ecosystem.config.cjs` forbids it.
- **Re-run `scripts/sql/capture-grants.sql`** after any schema push that adds
  a table to the `capture` schema.
