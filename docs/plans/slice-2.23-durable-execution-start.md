# Slice 2.23 durable execution-start barrier

Status: Planned

Date: 2026-07-31

Architecture: ADR-045, ADR-046, ADR-054, ADR-057, ADR-060

## Outcome

Create a durable, fail-closed boundary between a claimed attempt that remains
safe to prepare and an attempt whose sandbox may already have executed.

## Record

Add immutable `execution-start.json` to each work-journal item with:

- schema version `1`;
- delivery key;
- digest of the exact durable `RunnerExecutionV1` claim;
- exact attempt key derived from runner/task/attempt/fence;
- canonical runner-clock `startedAt` timestamp;
- checksum over the canonical core record.

Use the existing private-filesystem publication protocol: bounded canonical
bytes, temporary file, file sync, atomic no-overwrite publication, and parent
directory sync. The existing per-record and aggregate journal limits remain
authoritative.

## State machine

Add `LocalWorkJournal.commitExecutionStart(deliveryId, execution)`.

- A matching durable claim is required.
- The execution digest and attempt key must match that claim exactly.
- Exact replay returns the original timestamp and does not rewrite bytes.
- A different execution, rejection, completion-before-start, malformed file,
  checksum drift, orphan record, or unexpected entry fails closed.
- Completion may follow execution start.
- Completion without execution start remains valid for pre-start
  cancellation.

Public state order is `completed`, `execution_started`, `claimed`, `rejected`,
then `pending_claim`.

## Recovery admission

`WorkAdmissionCoordinator.prepareNext` must include `execution_started` in its
oldest actionable search. It returns an immutable `indeterminate` result with
the durable work and exact frozen execution. It must not call claim, acquire
new work, or expose the attempt as `ready`.

This slice deliberately blocks on indeterminate work. A later protocol will
use database-clocked lease state to resolve it without re-execution.

## Failure matrix

- crash before temporary open, after write, after file sync, and after rename;
- missing claim, rejection, or already completed work;
- execution digest, delivery key, attempt key, and checksum drift;
- symlink, directory, unknown file, noncanonical JSON, and oversize records;
- concurrent and sequential exact replay;
- conflicting replay and completion ordering;
- restart before publication versus restart after durable publication;
- recovery attempting claim/acquire for indeterminate work.

## Delivery order

1. Commit ADR-060 and this plan before production code.
2. Add record contracts and canonical codec tests.
3. Extend the private filesystem and journal loader invariants.
4. Implement exact/replay/conflict transition semantics.
5. Add indeterminate recovery admission behavior.
6. Run local and GitHub Actions gates before admitting ADR-060.

## Exit criteria

1. No sandbox-starting caller can proceed without a durable exact marker.
2. A durable marker can never be interpreted as fresh executable work.
3. Crash recovery is deterministic at every publication fault boundary.
4. Pre-start cancellation completion remains representable.
5. Journal corruption and capacity violations fail closed.
6. Execution, lease reconciliation, evidence delivery, and runner enablement
   remain disabled.
