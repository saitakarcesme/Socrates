# Phase 2 scheduler foundation evidence

Status: Verified sub-slice

Date: 2026-07-31

Scope: Phase 2.1 durable scheduling, cancellation, fenced terminal completion,
expired-lease reconciliation, and ordered runner-event ingestion. This
evidence does not claim bounded log/artifact storage, a fake runner, or
executable sandbox support.

## Persistence proof

A fresh PostgreSQL 17 database accepted the complete migration chain from
`0000` through `0007`. Runtime compatibility then reported schema version `4`.
Drizzle schema consistency passed after generation of cancellation, active
lease, and ordered event persistence.

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

The ordered event suite additionally proves:

- concurrent exact event replay creates one row and returns one replay;
- sequence gaps return the expected cursor without mutation;
- event-ID and attempt-sequence reuse with different content conflict;
- stale fences and expired leases cannot append evidence;
- source, image, command order, metric identity, and unit match the frozen task;
- restart replay remains acknowledged after the task becomes terminal;
- terminal evidence, cursor, attempt, task, outbox, and run projection commit
  atomically; and
- log and artifact messages remain unsupported until bounded storage lands.

The query-plan suite forces index scans and verifies that the bounded expiry
query uses `runner_task_attempts_active_lease_id_idx` without an explicit sort.

## Verification matrix

```text
pnpm format:check        passed
pnpm typecheck           passed
pnpm lint                passed
pnpm audit:phase-1       passed
pnpm audit:phase-2       passed
pnpm test                passed (204 tests)
pnpm build               passed
pnpm test:e2e            passed (Chromium, 1 journey)
```

Database package result on the fresh PostgreSQL instance: 44 tests passed,
including 20 scheduler integration tests, 12 query-plan tests, and 7 migration
tests.

API application result: 53 tests passed, including 15 exhaustive runner-gateway
mapping tests.

## Phase 2.1 status

Complete. The next planned work is Slice 2.2's deterministic fake-runner
vertical slice. Public runner transport remains intentionally absent until its
deployment authentication adapter is defined.
