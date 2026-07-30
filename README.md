# Socrates

Socrates is a web-first autoresearch platform for measurable, iterative
optimization. It turns an objective into a controlled sequence of hypotheses,
actions, measurements, decisions, and accumulated knowledge.

The current milestone is the product and architecture skeleton. Autonomous
execution is intentionally out of scope.

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

```bash
pnpm install
pnpm dev
```

The web application runs on port `3000`; the API runs on port `3001`.
