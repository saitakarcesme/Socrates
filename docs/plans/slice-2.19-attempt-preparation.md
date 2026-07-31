# Slice 2.19 owned attempt preparation

Status: Complete

Date: 2026-07-31

Architecture: ADR-033, ADR-040, ADR-044, ADR-054, ADR-055, ADR-056

## Outcome

Prepare the immutable capabilities required by one claimed local-runner
attempt while preserving exact identity, cancellation authority, bounded
resource ownership, and deterministic compensation.

## Boundary

Add a process-local `AttemptPreparationCoordinator` to the runner-local
`execution` module. Construction binds one frozen `RunnerExecutionV1` and
requires explicit ports for pure projection, exact source-artifact resolution,
trusted image admission, and source materialization/release.

The coordinator may consume existing contract, artifact, image, source, and
profile capabilities. It cannot access environment configuration, clocks,
timers, transport, the work journal, the event spool, runtime-request files,
the OCI backend, or global resource recovery.

## Ordered preparation

1. Validate and project the frozen execution before any I/O.
2. Reject an already-aborted signal before calling a port.
3. Resolve the exact source `(snapshotId, digest)` to an opaque verified
   artifact capability.
4. Prove the capability is genuine and its digest is exact.
5. Admit the exact image digest and architecture from the frozen environment.
6. Prove the image capability is genuine and its digest/platform are exact.
7. Materialize the verified source for the exact lease identity.
8. Prove the source capability is live and matches the attempt key and digest.
9. Check cancellation once more before publishing an immutable prepared result.

The same authoritative signal is passed to attempt-scoped source I/O ports and
checked after every await. It is not passed into image admission because the
catalog shares an in-flight admission promise by image identity; one attempt
must not cancel another attempt's shared admission. Image admission is instead
guarded by immediate pre/post cancellation checks and precedes per-attempt
source materialization because it owns no attempt-scoped cleanup.

## Ownership and restart semantics

- one coordinator owns one preparation promise and one release promise;
- concurrent and later preparation calls replay the original result or error;
- a later signal cannot replace the first signal;
- any error after source issuance releases that exact capability first;
- compensation failure becomes an explicit cleanup failure with both causes;
- explicit release is idempotent and concurrent calls share its result;
- release failure is retained and is not silently retried;
- no opaque local capability is journaled or serialized;
- startup recovery remains a global pre-admission responsibility;
- recovered durable claims create fresh coordinators and capabilities.

## Failure matrix

- malformed execution or lease/task identity drift before I/O;
- projection rejection before I/O;
- cancellation before the first port and after every awaited boundary;
- one cancelled attempt cannot abort shared image admission for another;
- missing source snapshot;
- forged artifact capability or source digest drift;
- artifact resolver rejection;
- image admission rejection;
- forged image capability, digest drift, or architecture drift;
- source materializer rejection;
- forged, released, wrong-attempt, or wrong-digest source capability;
- cancellation immediately after source materialization;
- source compensation rejection after a primary failure;
- concurrent preparation calls with no duplicated port invocation;
- duplicate explicit release with no duplicated materializer release;
- explicit release rejection replayed to every caller;
- attempts to invoke global recovery, runtime request materialization, sandbox
  execution, timers, transport, persistence, or event publication.

## Delivery order

1. Commit ADR-056 and this plan before production code.
2. Add closed port, result, and error types.
3. Implement one-shot ordered preparation and strict capability validation.
4. Implement compensating and explicit release state machines.
5. Add table, race, cancellation, mutation, and failure-injection tests.
6. Run all local and GitHub Actions gates before admitting ADR-056.

## Exit criteria

1. No side effect occurs before the execution plan is accepted.
2. Every capability is exact, genuine, and derived from the frozen execution.
3. Duplicate callers cannot duplicate preparation or replace cancellation.
4. No post-materialization failure can report success or skip compensation.
5. Release is exact, idempotent, concurrency-safe, and fail-closed.
6. Restart reconstruction requires no serialized local capability.
7. Runtime requests, sandboxes, events, and production execution remain off.
8. Full repository, native durability, browser, build, and CI gates pass.

## Evidence

Implementation commit `2645428`; GitHub Actions run `30658886159` passed 248
runner-local tests, all PostgreSQL/API/runner integrations, both native
durability probes, the Chromium product journey, and production builds. Local
format, type, lint, Phase 1/2 boundary audit, workspace test, and build gates
also passed.
