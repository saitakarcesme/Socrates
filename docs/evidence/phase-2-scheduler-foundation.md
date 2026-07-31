# Phase 2 scheduler foundation evidence

Status: Verified sub-slice

Date: 2026-07-31

Scope: Phase 2.1 durable scheduling, Phase 2.2 deterministic fake-runner
orchestration, and Phase 2.3 bounded log/artifact admission. This evidence does
not claim executable sandbox support.

## Persistence proof

A fresh PostgreSQL 17 database accepted the complete migration chain from
`0000` through `0008`. Runtime compatibility then reported schema version `5`.
Drizzle schema consistency passed after generation of cancellation, active
lease, ordered event persistence, quota counters, and artifact metadata.

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
  atomically.

The query-plan suite forces index scans and verifies that the bounded expiry
query uses `runner_task_attempts_active_lease_id_idx` without an explicit sort.

## Verification matrix

```text
pnpm format:check        passed
pnpm typecheck           passed
pnpm lint                passed
pnpm audit:phase-1       passed
pnpm audit:phase-2       passed
pnpm test                passed (169 tests; 51 DB-dependent tests skipped)
pnpm build               passed
```

Database package result on the fresh PostgreSQL instance: 48 tests passed,
including 21 scheduler integration tests, 12 query-plan tests, and 8 migration
tests.

API application unit result: 43 tests passed, including 16 exhaustive
runner-gateway mapping tests.

## Phase 2.1 status

Complete. Public runner transport remains intentionally absent until its
deployment authentication adapter is defined.

## Slice 2.2 fake-runner evidence

The test-only execution-plane adapter passed five tests, including three real
PostgreSQL vertical journeys: successful claim-to-terminal execution with
restart replay, sequence-gap recovery, and durable cancellation with restart
replay. The adapter performed no external execution or I/O.

## Slice 2.3 bounded-evidence proof

The local artifact-store package passed five disposable-filesystem tests. It
streams bytes into a private temporary object, verifies exact size and SHA-256
identity, publishes under a digest-derived path, accepts identical content
idempotently, and rejects traversal-shaped digests, digest mismatch, and
oversize input. Filesystem paths do not enter a protocol or database contract.

The PostgreSQL scheduler tests additionally prove:

- log text receives deterministic secondary redaction before persistence;
- markup remains literal text and log events are omitted from the run-event
  projection;
- log and artifact counters advance with the event cursor in one transaction;
- exact replay does not consume byte quota twice;
- quota exhaustion does not insert metadata or consume a sequence number;
- evidence events do not disturb lifecycle ordering;
- artifact metadata requires an in-process verified-store capability;
- artifact content identity and attempt/event provenance remain separate; and
- malformed media types fail contract validation.

Binary artifact content remains outside PostgreSQL. Retention metadata is
explicitly `run_evidence`; a deletion reconciler remains intentionally out of
scope.
