# Slice 2.27 mandatory runtime start barrier

Status: Planned

Date: 2026-07-31

Architecture: ADR-045, ADR-056, ADR-060, ADR-061, ADR-064

## Outcome

Make durable execution-start publication a mandatory, non-bypassable boundary
inside runtime execution without composing or enabling an attempt session.

## Executor order

1. Validate the frozen runtime request and bound capabilities.
2. Materialize the read-only request envelope.
3. Reject cancellation observed before irreversible execution.
4. Await the required start barrier.
5. Invoke the sandbox backend immediately with no intervening asynchronous
   work.
6. Release the request envelope on every outcome.
7. Validate runtime output only after the backend settles.

Request release failure has one stable `request_release_failed`
classification. If another operation already failed, retain both causes only
in an in-memory aggregate; never let cleanup erase the primary boundary and
never copy either cause into lifecycle evidence.

## Durable capability

Add one `DurableExecutionStartBarrier` that binds delivery ID and validated
execution at construction. Its `cross()` operation calls only
`LocalWorkJournal.commitExecutionStart`, accepts only `execution_started`, and
shares the first promise across concurrent and sequential replay.

The capability exposes no journal path, timestamp, checksum, or mutable state.
It cannot change identity after construction and cannot retry an uncertain
first publication.

## Failure matrix

- malformed execution or delivery identity before journal access;
- cancellation before materialization, during materialization, and before the
  barrier;
- request materialization failure and invalid request capability;
- every journal start-publication fault;
- unexpected journal state or identity drift;
- synchronous and asynchronous backend failure after a successful barrier;
- request-release failure before and after the barrier;
- concurrent and sequential barrier replay;
- exact call-order proof with no async work between crossing and backend
  invocation;
- compile-time and repository search proof that executor calls cannot omit the
  barrier.

## Delivery order

1. Commit ADR-064 and this plan before production code.
2. Define the required runtime start-barrier port.
3. Add the exact journal-bound durable barrier capability.
4. Place the barrier at the executor's final pre-backend boundary.
5. Update all deterministic and native callers with explicit barriers.
6. Add order, fault, cancellation, replay, and cleanup tests.
7. Run all local and GitHub Actions gates before admitting ADR-064.

## Exit criteria

1. Runtime execution cannot compile without an explicit start barrier.
2. Pre-barrier failure never calls the sandbox backend.
3. Successful crossing is the final asynchronous step before backend
   invocation.
4. Request capabilities are released on every post-materialization path.
5. Barrier identity and first result are immutable across replay.
6. No lifecycle evidence or completion is invented.
7. Admission, session composition, polling, and runner enablement remain
   disabled.
