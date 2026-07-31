# Slice 2.14 restart-first work admission plan

Status: Planned

Date: 2026-07-31

Architecture: ADR-046, ADR-047, ADR-048, ADR-049, ADR-050, ADR-051

## Outcome

Create one crash-safe, single-transition coordinator that recovers local work
before acquiring new work, publishes either the exact claim or an authoritative
rejection, and never enables task execution.

## Boundary

Add an immutable work-rejection record, extend journal inspection with the
closed `rejected` state, and compose source/journal/exact claim behind one
`prepareNext` operation. Do not add a process loop, timer, backoff, heartbeat,
cancellation monitor, executor, event sender orchestration, completion marker,
cleanup, or production entry point.

## Durable state

```text
pending_claim -> claimed
pending_claim -> rejected(control_plane_conflict)
```

The manifest remains the identity root. Claim and rejection records are
mutually exclusive, immutable, checksum-protected, privately published, and
bounded by per-record and total-journal limits. A rejection stores only the
closed reason, validated API conflict metadata, and commit timestamp; it does
not store response bodies or credentials.

## Coordinator order

1. Serialize the call in-process.
2. List and validate the journal.
3. Select the oldest actionable item by admission timestamp and delivery ID.
4. Return an existing claim without network traffic.
5. Retry a pending claim with its durable delivery/task/attempt identity.
6. Persist a validated claim response before returning ready.
7. Persist an authenticated contract-valid claim conflict before returning
   rejected.
8. Only with no pending or claimed item, acquire at most one delivery, admit
   it, and perform the same exact claim transition.
9. Return idle when acquire returns no delivery.

Rejected entries are diagnostic history and do not block a later call from
acquiring new work. Claimed entries remain active and block acquisition until
a future completion/retention slice defines their lifecycle.

## Failure policy

- abort, timeout, network, unauthorized, forbidden, server, response-too-large,
  and protocol errors leave `pending_claim` unchanged;
- only `RunnerTransportError(code="conflict")` carrying validated response
  metadata can produce `rejected`;
- a crash before terminal publication repeats the same idempotent claim or
  conflict;
- a crash after terminal publication returns local truth without another
  claim;
- conflicting terminal records, partial records, checksum failures, identity
  mismatch, and capacity exhaustion fail closed.

## Adversarial matrix

- empty journal plus idle source;
- empty journal plus newly admitted and claimed delivery;
- restart with pending manifest and no acquire call;
- restart with claimed record and no network call;
- authoritative conflict followed by byte-identical rejected replay;
- non-authoritative transport failures remain pending;
- claim/rejection mutual exclusion and identity mismatch;
- deterministic ordering with rejected history and multiple actionable items;
- simultaneous `prepareNext` calls serialize;
- fault injection before/after temp write, sync, publication, and directory
  sync for rejection records;
- native filesystem permissions and restart recovery;
- journal item/record/total byte limits include rejection records;
- `LocalRunnerNotEnabledError` remains unchanged.

## Delivery order

1. Commit ADR-051 and this plan before production code.
2. Add rejection contracts, codec, filesystem operations, and journal methods.
3. Add the restart-first admission coordinator and explicit result union.
4. Add unit, fault-boundary, restart, concurrency, and native durability tests.
5. Run full local and GitHub Actions gates before admitting ADR-051.

## Exit criteria

1. Durable local work is always inspected before acquire.
2. Pending work reuses the exact durable attempt UUID.
3. Claimed work produces no acquire or claim traffic.
4. Only an authoritative validated conflict becomes rejected.
5. Rejected work never becomes claimed and does not block later acquisition.
6. One call performs at most one acquire and one claim transition.
7. Concurrent calls cannot allocate separate work accidentally.
8. Every crash boundary recovers to empty, pending, claimed, or rejected truth.
9. No execution, supervision, cleanup, or production enablement is introduced.
10. Full repository, native durability, browser, build, and CI gates pass.
