# Phase 2 scheduler foundation evidence

Status: Verified sub-slice

Date: 2026-07-31

Scope: Phase 2.1 durable cancellation, fenced terminal completion, and expired
lease reconciliation. This evidence does not claim runner event ingestion,
timeline projection, a fake runner, or executable sandbox support.

## Persistence proof

A fresh PostgreSQL 17 database accepted the complete migration chain from
`0000` through `0006`. Runtime compatibility then reported schema version `3`.
Drizzle schema consistency passed after generation of the cancellation table
and active-lease index.

The scheduler integration suite proves:

- a queued cancellation becomes terminal and stores one append-only request;
- cancellation replay returns the original accepted request;
- one request ID cannot identify two tasks;
- concurrent fenced terminal writes produce exactly one terminal winner;
- an expired lease cannot complete a task;
- reconciliation marks the old attempt `expired`;
- retry-safe work returns to `queued` and the next claim advances the fence;
- non-retry-safe work becomes terminal `failed`;
- an expired cancellation request becomes terminal `cancelled`; and
- accepted lifecycle transitions append transactional outbox messages.

The query-plan suite forces index scans and verifies that the bounded expiry
query uses `runner_task_attempts_active_lease_id_idx` without an explicit sort.

## Verification matrix

```text
pnpm format:check        passed
pnpm typecheck           passed
pnpm lint                passed
pnpm audit:phase-1       passed
pnpm audit:phase-2       passed
pnpm test                passed (182 tests)
pnpm build               passed
pnpm test:e2e            passed (Chromium, 1 journey)
```

Database package result on the fresh PostgreSQL instance: 37 tests passed,
including 15 scheduler integration tests and 11 query-plan tests.

## Remaining Phase 2.1 work

- acknowledged, ordered runner event persistence;
- conflicting attempt-ID mapping at the API error boundary; and
- durable task lifecycle projection into the run timeline.
