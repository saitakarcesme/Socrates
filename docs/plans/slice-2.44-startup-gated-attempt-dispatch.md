# Slice 2.44 startup-gated attempt dispatch

Status: Planned

Date: 2026-08-01

Architecture: ADR-057, ADR-075, ADR-077, ADR-080, ADR-081

## Outcome

Connect the admitted startup recovery barrier to exactly serialized work
admission and fresh/restart session routing without creating a production
process root, timer, or polling loop.

## Deferred composition

`StartupGatedAttemptDispatcher` accepts only:

1. one already-constructed `RunnerStartupRecoveryBarrier` around fresh,
   unused exact-owner sandbox and source recovery ports;
2. one deferred composition factory invoked only after the barrier succeeds.

The factory returns one immutable composition containing an admission port,
one fresh-session factory, and one restart-recovery-session factory. It may
open and bind durable stores and the post-recovery attempt dependencies. The
dispatcher never receives prebuilt admission or session services and never
invokes the factory during construction.

Startup recovery and composition are each single-flight and retained. A
failed barrier cannot compose. A failed composition cannot be repeated. The
startup result is deeply immutable and may be passed to the factory only as
diagnostic evidence; counts never affect admission or session policy.

## Explicit dispatch

Each `dispatchNext(signal?)` operation is serialized through complete
settlement:

1. await shared startup recovery and deferred composition;
2. invoke `prepareNext(signal)` once;
3. for `ready`, construct one fresh session and await `settle()`;
4. for `recovery_pending`, construct one restart session and await `settle()`;
5. for every other admission state, construct no session;
6. return one exact deeply immutable dispatch result before releasing the next
   queued caller.

The signal belongs only to admission. It is not forwarded to either session
and cannot supersede authenticated cancellation after a handoff. Concurrent
callers queue in invocation order. They do not share a result and cannot cause
overlapping admission, execution, recovery, heartbeat, or publication.

## Result contract

Non-session states retain the admitted `idle`, `rejected`, `indeterminate`,
`retired`, or `completed` shape.

A settled session returns an immutable wrapper:

```text
{
  state: "settled",
  path: "fresh" | "restart_recovery",
  deliveryId,
  execution,
  result
}
```

Fresh results are the exact ADR-080 completed/no-evidence union. Restart
results are exact ADR-077 publication completion. Delivery and execution must
equal the routed handoff and may not be supplied by a session result.

## Fail-stop ownership

The first rejection from startup, deferred composition, admission, session
construction, or session settlement is retained as the dispatcher's terminal
failure. Current and later callers receive that same failure identity. No
later call can repeat cleanup, reopen composition, acquire, reconcile, start a
heartbeat, construct another session, or publish. A new process is required.

Successful `idle`, non-session terminal states, completed sessions, and fresh
no-evidence release do not poison the dispatcher. A later explicit call still
runs ADR-075 restart-first triage before any new acquire.

## Failure matrix

- construction without cleanup, factory, store, admission, or session effects;
- startup pending/success/sandbox failure/source failure/invalid result and
  concurrent callers sharing exactly one barrier operation;
- composition pending/success/synchronous failure/asynchronous failure,
  mutation, and retained replay;
- every `WorkAdmissionResult` state and strict path-specific session routing;
- fresh and recovered `ready`, exact `recovery_pending`, and malformed output
  from a trusted-but-fault-injected admission port;
- fresh completed/no-evidence results and restart completion;
- session factory throw, settle rejection, contradictory or mutated result;
- caller abort before admission, during admission, after handoff, and while
  queued behind an active session;
- concurrent calls cannot overlap admission or session settlement;
- sequential success dispatches remain distinct and ordered;
- every first failure prevents all later effects and replays exact identity;
- deep immutability, fixed errors, cause retention in memory, and dependency
  mutation after construction;
- real startup barrier plus admission/session ports proving cleanup precedes
  the first journal/control-plane effect and a second admission waits for full
  authority/publication settlement.

## Delivery order

1. Commit ADR-081 and this plan before production code.
2. Add narrow deferred-composition, session-factory, and result contracts.
3. Implement retained startup/composition and fail-stop dispatch state.
4. Implement whole-attempt serialization and exact admission routing.
5. Add adversarial ordering, failure, identity, and real composition tests.
6. Run every local and GitHub Actions gate before admitting ADR-081.

## Exit criteria

1. No admission or post-recovery composition effect can precede startup
   recovery success.
2. No second admission can begin before the prior session fully settles.
3. `ready` and `recovery_pending` can reach only their exact session path.
4. Non-session admission states create no session or terminal evidence effect.
5. The first uncertain or failed boundary permanently prevents in-process
   retry and later side effects.
6. Caller signals cannot become attempt cancellation authority after handoff.
7. No process entry point, environment loading, signal handler, timer, polling,
   backoff, concurrency scheduler, or runner enablement is added.
