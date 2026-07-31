# Slice 2.13 expired offer revocation plan

Status: Planned

Date: 2026-07-31

Architecture: ADR-031, ADR-035, ADR-048, ADR-049, ADR-050

## Outcome

Bound every unclaimed task offer in database time, durably revoke expired
offers in deterministic batches, and safely issue a new delivery without
allowing the stale journal identity to claim the task.

## Boundary

Add delivery expiry/revocation columns and constraints, a trusted acquire
duration, a repository reconciliation operation, and adversarial PostgreSQL
tests. Do not add a timer, cron route, admin endpoint, broker, retry loop,
claimed-lease reconciliation, row deletion, journal cleanup, or execution.

## State machine

```text
offered -> claimed
offered -> revoked(reason=expired) -> new delivery may be offered
```

`claimed` and `revoked` are terminal delivery states. Task lifecycle remains
owned by the scheduler; revoking a delivery does not mutate the queued task.

## Trusted time and duration

- `offerDurationMs` is a positive bounded application option, never request
  JSON;
- repository acquire computes expiry with transaction-stable database time;
- persisted `expiresAt` must be later than `offeredAt`;
- claim accepts an offered delivery only while `expiresAt > CURRENT_TIMESTAMP`;
- client clock, network latency, and journal timestamps are not authoritative.

## Reconciliation transaction

1. Validate a positive bounded batch limit.
2. Select expired `offered` rows ordered by expiry and ID.
3. Lock only the bounded rows with `FOR UPDATE SKIP LOCKED`.
4. Update each selected row to `revoked`, database timestamp, reason `expired`.
5. Return immutable delivery/task/runner diagnostics after commit.

Multiple reconcilers may run concurrently without returning the same row.

## Claim/revoke serialization

Both operations first lock the delivery row. Tests exercise each ordering:

- claim lock first: lease and claimed delivery commit, revoke returns nothing;
- revoke lock first: delivery becomes revoked, claim returns conflict, no
  attempt or fence is created.

No implementation may inspect state, release the lock, and later mutate it.

## Migration

Schema compatibility advances to 8. Existing rows receive deterministic
backfilled expiry values before `NOT NULL` is applied. The migration replaces
the state and complete-identity checks, adds expiry/revocation checks, and adds
an `offered` expiry-order index. Referenced unique indexes remain before foreign
keys and compatibility advances only in the last statement.

## Adversarial matrix

- duration zero, negative, unsafe integer, and above maximum;
- offered/claimed/revoked partial database shapes;
- expiry equal to database time and just after database time;
- bounded deterministic batches and two concurrent reconcilers;
- claim-first and revoke-first row-lock races;
- stale runner claim after reassignment;
- same-runner and different-runner new offer after revocation;
- claimed delivery ignored even after its offer expiry;
- inactive/capacity/capability/tenant constraints preserved;
- outbox, task status, current fence, and attempts unchanged by revocation;
- migration from schema 7 data and query-plan index evidence;
- local journal manifest retained after authoritative revocation.

## Delivery order

1. Update ADR and detailed plan before code.
2. Add migration, schema compatibility 8, constraints, and indexes.
3. Add trusted duration validation and expiry-aware acquire/claim.
4. Add bounded revocation repository operation.
5. Add unit and real PostgreSQL state/race/reassignment tests.
6. Run full local and CI gates before amending ADR-050 with evidence.

## Exit criteria

1. Every new offer has a database-computed finite expiry.
2. Only expired unclaimed offers can be revoked.
3. Claim and revoke cannot both succeed for one delivery.
4. A revoked delivery can never create a scheduler attempt.
5. Reassignment uses a new delivery UUID and preserves the old row.
6. Revocation never changes task status, fence, attempts, or outbox.
7. Concurrent reconcilers return disjoint bounded results.
8. Claimed deliveries remain outside this lifecycle.
9. Client/journal clocks cannot influence authority.
10. Timers, cleanup, execution, and production enablement remain absent.
11. Full repository, PostgreSQL, browser, build, and CI gates pass before the
    slice becomes Complete.
