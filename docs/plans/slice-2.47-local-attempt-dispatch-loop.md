# Slice 2.47 local attempt dispatch loop

Status: Planned

Date: 2026-08-02

Architecture: ADR-057, ADR-061, ADR-072, ADR-081, ADR-082, ADR-083, ADR-084

## Outcome

Add one explicit, observed, serial lifecycle around the recovery-bound local
attempt owner without enabling a production process entry point.

## Lifecycle contract

`LocalAttemptDispatchLoop` captures three narrow capabilities:

1. an owner exposing `dispatchNext(signal?)`;
2. a delay exposing `wait(delayMs, signal)`;
3. an observer exposing `observe(result)`.

It also snapshots one integer `pollIntervalMs` in `[1, 2_147_483_647]`.
Construction is effect-free. The first `run(signal)` owns one retained
operation, and every later call returns that same promise.

Each cycle is strictly ordered:

1. stop before effects when the signal is already aborted;
2. await exactly one dispatch;
3. validate and deeply snapshot the closed ADR-081 result;
4. await exactly one observation of that snapshot;
5. stop if shutdown arrived during owned settlement or observation;
6. wait once after `idle` or `indeterminate` only;
7. otherwise begin the next dispatch immediately.

No dispatch, observer, or delay overlaps another lifecycle effect.

## Outcome policy

- `idle`: observe, then wait before another acquire attempt;
- `indeterminate`: observe, then wait before exact server reconciliation;
- `settled`: observe, then immediately let admission expose durable completion
  or remaining recovery truth;
- `completed`, `retired`, `rejected`: observe, then immediately advance past
  the already-closed local record.

The loop never reads `observedAt` or `leaseExpiresAt`, never calls a wall clock,
and never decides that an active attempt has retired. Only ADR-061 control-plane
reconciliation can make that transition.

## Shutdown and failure policy

- already-aborted input returns frozen `{ state: "stopped" }` without effects;
- exact `signal.reason` rejection during dispatch or delay is cooperative stop;
- shutdown after session handoff waits for ADR-081 settlement and observation
  before stopping;
- the private abort reason is never included in the stopped result or message;
- unexpected dispatch, observation, or delay rejection becomes a fixed typed
  fail-stop error retaining only an in-memory cause;
- malformed dispatch results fail with a separate fixed error;
- no failed operation is retried and no later lifecycle effect is started.

## Adversarial matrix

- inert construction, invalid interval, missing/throwing dependency methods,
  and dependency mutation after capture;
- abort before run, during dispatch, during owned settlement, during
  observation, and during delay;
- exact string, symbol, object, Error, and DOMException shutdown identity;
- idle delay with no immediate second acquire and no busy spin;
- indeterminate delay with no local clock or lease-expiry interpretation;
- immediate advancement after settled/completed/retired/rejected outcomes;
- observer-before-next ordering for every valid state;
- concurrent/repeated `run()` calls share one exact operation;
- unexpected dispatch, observer, and delay failures retain one fixed terminal
  failure and produce no retry;
- malformed, mutable, or extra-key results fail closed;
- real `LocalAttemptOwner` idle integration and real ADR-083 scheduler stop.

## Delivery order

1. Commit ADR-084 and this plan before production code.
2. Add strict lifecycle capability, result, and error contracts.
3. Implement the retained serial dispatch loop and closed outcome policy.
4. Export it through the session module boundary without wiring an entry point.
5. Add adversarial fake-capability and real owner/scheduler integration tests.
6. Run every local and GitHub Actions gate before admitting ADR-084.

## Exit criteria

1. At most one dispatch/session is owned at any moment.
2. Every successful dispatch is observed exactly once before another effect.
3. Idle and indeterminate outcomes cannot busy-spin.
4. Local time never converts indeterminate work into retirement.
5. Cooperative shutdown cannot detach or cancel an authenticated attempt.
6. Every unexpected failure is retained and cannot retry in-process.
7. No environment loader, process entry point, OS signal handler, shutdown
   timeout, adaptive backoff, concurrency scheduler, or runner enablement
   lands.
