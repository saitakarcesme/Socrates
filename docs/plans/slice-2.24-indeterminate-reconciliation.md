# Slice 2.24 indeterminate attempt reconciliation

Status: Planned

Date: 2026-07-31

Architecture: ADR-035, ADR-036, ADR-045, ADR-046, ADR-060, ADR-061

## Outcome

Resolve a durable `execution_started` item only from serialized,
database-clocked scheduler truth, then persist that retirement before allowing
future work admission.

## Control-plane command

Add an authenticated exact-attempt reconciliation request carrying version and
positive fence. Runner identity comes only from the bearer principal. Its
response is a strict discriminated union:

- `current`: exact active attempt, current fence, unexpired lease, and exact
  database lease expiry;
- `retired`: exact attempt no longer has write authority, with server
  observation time and one closed reason/outcome.

Missing or foreign identity is a typed conflict. The response never returns
task payload, source identity, filesystem data, or another runner's state.

## Scheduler semantics

Lock the exact task and attempt together before classification. Reuse one
internal expiry transition for exact reconciliation and bounded background
reconciliation so retry-safe requeue, cancellation, non-retry-safe failure,
attempt expiry, and transactional outbox behavior cannot drift.

- Active and unexpired remains `current`; do not renew it.
- Active and expired becomes `retired` through the shared expiry transition.
- Terminal attempt, terminal task, or superseded fence is already `retired`.
- Identity mismatch remains conflict and performs no write.
- Concurrent heartbeat, completion, cancellation, and expiry are serialized;
  no response may retire an attempt that can later renew or write evidence.

## Durable local retirement

Add immutable `execution-retirement.json` with delivery key, execution digest,
attempt key, server observation timestamp, closed reason/outcome, commit time,
and checksum. Publish it through the existing bounded private-filesystem
protocol.

Retirement requires a matching execution-start record. Exact replay returns
the first bytes. Conflict, orphan retirement, retirement after acknowledged
completion, checksum drift, unknown entries, or capacity overflow fails closed.
Public state `retired` remains distinct from `completed`.

## Admission behavior

When the oldest actionable work is `execution_started`, reconcile it exactly:

- `current` returns `indeterminate` and leaves the journal unchanged;
- `retired` commits local retirement and returns `retired`;
- transport ambiguity or invalid data propagates and leaves it indeterminate.

Perform at most one remote reconciliation per `prepareNext` call. A later call
may skip retired work and acquire another delivery.

## Failure matrix

- exact identity, runner ownership, and fence mismatch;
- heartbeat before/after lock and expiry before/after reconciliation;
- cancellation, completion, bounded expiry, and exact reconciliation races;
- retry-safe, non-retry-safe, and cancellation-requested expiry outcomes;
- malformed, redirected, oversized, timed-out, or ambiguous HTTP response;
- all six immutable publication fault boundaries;
- orphan, checksum, delivery, execution digest, attempt key, and reason drift;
- restart before and after server retirement or local retirement publication;
- acquisition attempted in the same call or before durable retirement.

## Delivery order

1. Commit ADR-061 and this plan before production code.
2. Add strict transport contracts and scheduler port types.
3. Refactor one shared locked expiry transition and add PostgreSQL race tests.
4. Expose the authenticated API command and bounded runner client operation.
5. Add the immutable local retirement record and recovery invariants.
6. Integrate one-shot admission reconciliation and adversarial tests.
7. Extend native evidence and run all local and GitHub Actions gates before
   admitting ADR-061.

## Exit criteria

1. Local clocks never decide retirement.
2. Current reconciliation never renews a lease.
3. Retirement is monotonic against concurrent heartbeat and terminal writes.
4. Background and exact expiry semantics share one implementation.
5. Admission advances only after durable exact local retirement.
6. No runtime result or terminal acknowledgement is invented.
7. Polling, sandbox execution, cleanup, and runner enablement remain disabled.
