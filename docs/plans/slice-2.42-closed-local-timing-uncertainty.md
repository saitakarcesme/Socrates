# Slice 2.42 closed local timing uncertainty

Status: Planned

Date: 2026-08-01

Architecture: ADR-060, ADR-062, ADR-069, ADR-070, ADR-071, ADR-078, ADR-079

## Outcome

Close the last typed local-observation rejection that prevents a future fresh
attempt session from reaching deterministic terminal arbitration. Exact
monotonic timing uncertainty becomes a redacted fact and produces no terminal
evidence.

## Contract

Extend `TerminalExecutionTiming` with exactly:

```text
{ state: "uncertain", boundary: "monotonic_time" }
```

`AttemptExecutionObserver.observe()` may resolve this state only from an exact
`DurableExecutionTimingBarrierError` with code `timing_uncertain`, including a
nested error raised while crossing the durable start barrier or a direct
snapshot failure after execution. The observation contains no time value,
exception, stack, host path, or arbitrary dependency message and remains
deeply frozen and single-flight.

The observer must settle all request, sandbox, source, and compensating cleanup
ownership before returning. Exact cancellation and all existing stage-aware
failure normalization remain unchanged. An unrelated error concurrent with an
aborted signal cannot be reclassified as timing uncertainty.

## Arbitration

`TerminalOutcomeArbiter` strictly parses the new timing state and returns:

```text
{ state: "no_evidence", reason: "observation_uncertain" }
```

Ordering is fixed:

1. parse and validate timing, candidate, and authority completely;
2. preserve stale and uncertain authority as `authority_lost` or
   `authority_uncertain`;
3. validate authenticated cancellation identity against the frozen execution;
4. suppress renewed or valid-cancelled evidence when timing is uncertain;
5. preserve every existing `not_started` and `started` decision.

Timing uncertainty never creates `task.failed`, `task.cancelled`, a guessed
zero duration, or a lease conclusion. The arbiter remains pure and reads no
clock.

## Failure matrix

- monotonic read throw, non-finite value, regression, and safe-integer overflow;
- uncertainty while crossing the durable start barrier and during final
  snapshot;
- runtime, local-failure, and absent candidates under renewed, cancelled,
  stale, and all uncertain authority boundaries;
- forged cancellation identity despite uncertain local timing;
- source/request/sandbox cleanup success and failure after timing uncertainty;
- concurrent and sequential observer calls returning one frozen observation;
- malformed boundary, unknown fields, arbitrary errors, nested cause depth,
  mutation, and secret-bearing dependency messages;
- unchanged zero, normal, and maximum-safe started timing plus pre-start paths;
- proof that no publication, heartbeat, release, journal completion, or event
  side effect is reachable from the new policy.

## Delivery order

1. Commit ADR-079 and this plan before production code.
2. Extend the closed timing and no-evidence unions.
3. Resolve only exact typed timing uncertainty from the local observer.
4. Add strict arbiter parsing, identity ordering, and precedence.
5. Add adversarial observer and arbiter tests.
6. Run every local and GitHub Actions gate before admitting ADR-079.

## Exit criteria

1. Exact timing uncertainty always reaches a frozen no-evidence decision.
2. No unknown duration is serialized, guessed, or converted into an event.
3. Authority-first precedence and cancellation identity validation remain
   intact.
4. Normal started and not-started arbitration is behaviorally unchanged.
5. No authority monitor, publication call, session, polling loop, or runner
   enablement is added.
