# Slice 2.46 Node attempt timing adapters

Status: Planned

Date: 2026-08-02

Architecture: ADR-026, ADR-079, ADR-082, ADR-083

## Outcome

Add explicit Node implementations for attempt-authority scheduling and
in-process monotonic elapsed timing without introducing work polling, process
startup, or hidden composition defaults.

## Authority scheduler contract

`NodeLeaseAuthorityScheduler` implements `LeaseAuthorityScheduler` and owns no
policy beyond one requested wait:

1. validate `delayMs` as an integer in `[1, 2_147_483_647]`;
2. validate the signal before any timer/listener effect;
3. if already aborted, reject with the exact `signal.reason` and schedule
   nothing;
4. otherwise attach one abort listener and schedule one referenced timer;
5. expiry removes the listener and resolves `undefined` once;
6. abort clears the timer, removes the listener, and rejects with the exact
   reason once;
7. every later callback or abort is inert.

The maximum matches Node's non-clamping timer range. Zero, fractions, negative
values, non-finite values, unsafe integers, and larger delays fail with a fixed
`invalid_wait` error before effects. A scheduling throw becomes one fixed
`schedule_failed` error with the private cause retained. Cancellation failure
does not replace an abort reason; the settlement guard makes any surviving
callback inert.

The class captures a narrow timer driver during effect-free construction for
deterministic fault/race tests. The system driver binds the Node
`setTimeout`/`clearTimeout` functions once. Dependency mutation after
construction cannot redirect scheduling or cancellation. Missing, throwing,
or non-function driver methods fail inert construction with a fixed
`invalid_driver` error.

## Monotonic source contract

`nodeMonotonicTimeSource` is a deeply frozen `MonotonicTimeSource` whose
`now()` calls `performance.now()` only when invoked. It does not read at import,
use wall time, round values, persist an epoch, or convert to integer units.
ADR-079 validates readings and computes elapsed milliseconds.

## Failure and race matrix

- construction causes no timer, listener, clock, or callback effect;
- minimum and maximum accepted delay; zero, fraction, negative, infinity,
  unsafe integer, and above-Node-maximum rejection;
- already-aborted string, symbol, object, `Error`, and default DOMException
  reasons reject by exact identity without scheduling;
- abort before expiry, expiry before abort, and same-turn competition;
- abort during listener registration and callback reentrancy;
- scheduling throw, cancellation throw, duplicate callback, and driver method
  mutation after construction;
- multiple independent waits and reuse after success/abort;
- listener removal and no late settlement or unhandled rejection;
- referenced system timer behavior is explicit and no `unref()` call exists;
- monotonic reads are on demand, finite/non-negative in Node, non-decreasing
  across immediate reads, and accepted by ADR-079;
- real `LeaseAuthorityMonitor` checkpoint/stop integration proves sentinel
  wake-ups are not misclassified as scheduler failure or sandbox revocation;
- real `DurableExecutionTimingBarrier` integration proves elapsed timing is
  process-monotonic and integer-normalized only at the consumer.

## Delivery order

1. Commit ADR-083 and this plan before production code.
2. Add fixed timing error and captured timer-driver contracts.
3. Implement bounded exact-reason Node authority waits.
4. Add the frozen on-demand Node monotonic source.
5. Export each adapter through its existing module boundary.
6. Add adversarial fake-driver plus real monitor/timing-barrier tests.
7. Run every local and GitHub Actions gate before admitting ADR-083.

## Exit criteria

1. Normal monitor wake-up and owner release preserve exact reason identity.
2. Invalid or clamped Node delays cannot schedule.
3. Every wait settles once and leaves no active listener/callback effect.
4. Scheduling faults are fixed/redacted; abort remains authoritative even if
   timer cancellation faults.
5. Monotonic time is read only on demand from `performance.now()`.
6. `LocalAttemptOwner` still requires explicit scheduler/time capabilities.
7. No work polling, idle delay, retry/backoff, process entry point, OS signal
   handling, shutdown lifecycle, or runner enablement lands.
