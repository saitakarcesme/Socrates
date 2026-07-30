# Socrates

Socrates is a web-first autoresearch platform for measurable, iterative
optimization. It turns an objective into a controlled sequence of hypotheses,
actions, measurements, decisions, and accumulated knowledge.

The product skeleton and the first measured research workflow are complete.
Socrates currently supports projects, metric protocols, guardrails, manual run
control, experiments, deterministic decisions, durable PostgreSQL facts, SSE
timeline updates, and accumulated learnings. Autonomous execution remains
intentionally out of scope.

## Workspace

```text
apps/web              Next.js product interface
apps/api              Hono control plane
packages/contracts    Process-boundary schemas
packages/domain       Framework-free research rules
packages/database     Drizzle schema boundary
packages/design-system
services/orchestrator Future research loop
services/runner-local Future local execution adapter
```

Read [Architecture.md](./Architecture.md) before making structural changes.
The next implementation milestone is specified in the
[Phase 1 measured experiments plan](./docs/plans/phase-1-measured-experiments.md).

## Development

Prerequisites are Node.js 22 or newer, pnpm 11, and PostgreSQL. Install the
workspace, migrate a database, and establish the development workspace:

```bash
pnpm install
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/socrates \
  pnpm --filter @socrates/database db:migrate
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/socrates \
  pnpm --filter @socrates/database db:seed-development
```

Expose the same `DATABASE_URL` to the process, then start both applications:

```bash
pnpm dev
```

The web application runs on port `3000`; the API runs on port `3001`.
`SOCRATES_API_URL` can override the server-side API origin when those processes
are not local.

## Database

PostgreSQL migrations are generated and reviewed from the Drizzle schema:

```bash
pnpm --filter @socrates/database db:generate
pnpm --filter @socrates/database db:check
DATABASE_URL=postgresql://... pnpm --filter @socrates/database db:migrate
DATABASE_URL=postgresql://... pnpm --filter @socrates/database db:seed-development
```

`db:push` is deliberately not exposed. With a migrated disposable database,
setting `DATABASE_URL` also enables the persistence integration tests during
`pnpm --filter @socrates/database test`.

## Verification

The default quality gates cover formatting, types, lint, unit and integration
tests, and production builds:

```bash
pnpm format:check
pnpm typecheck
pnpm lint
DATABASE_URL=postgresql://... pnpm test
pnpm build
```

The critical browser journey uses the real Next.js and Hono processes with the
migrated PostgreSQL database. Install Chromium once, seed the disposable
workspace, and run:

```bash
pnpm --filter @socrates/web exec playwright install chromium
DATABASE_URL=postgresql://... pnpm test:e2e
```
