# Slice 2.20 startup owned-resource recovery barrier

Status: Complete

Date: 2026-07-31

Architecture: ADR-040, ADR-044, ADR-056, ADR-057

## Outcome

Expose one fail-closed, process-level gate that removes stale exact-owned
sandboxes and source materializations before any recovered or newly acquired
work can enter attempt preparation.

## Boundary

Add a `RunnerStartupRecoveryBarrier` to runner-local's `execution` module. It
depends only on two narrow recovery ports: sandbox ownership recovery and
source ownership recovery. The supplied implementations must be fresh and
unused by a session.

The barrier cannot access configuration, environment, clocks, timers,
signals, transports, work admission, the journal, the spool, image admission,
attempt preparation, runtime requests, lifecycle adapters, or execution.

## Ordered recovery

1. Call sandbox `recoverOwned()` and await complete success.
2. Validate its result as a non-negative safe integer.
3. Call source `recoverOwned()` and await complete success.
4. Validate its result as a non-negative safe integer.
5. Publish one immutable `{ sandboxesRemoved, sourcesRemoved }` result.

Sandbox cleanup must precede source cleanup because a stale sandbox may still
mount a source tree. The operations are never parallelized.

## One-way state

- the first `recover()` call creates the only operation promise;
- concurrent and later calls receive that exact promise;
- success and failure are both retained;
- there is no per-call signal or caller-specific timeout;
- partial cleanup is never represented as readiness;
- a failed process must be restarted after the underlying condition changes;
- a new process creates fresh owners and a fresh barrier;
- work-facing services are composed only after successful recovery.

## Failure matrix

- sandbox recovery rejection prevents source recovery;
- invalid sandbox removed count prevents source recovery;
- source recovery rejection after sandbox success rejects the whole barrier;
- invalid source removed count rejects the whole barrier;
- negative, fractional, unsafe, `NaN`, and infinite counts;
- concurrent callers cannot duplicate or reorder either cleanup;
- later calls replay the original error without retry;
- mutation attempts cannot change the success result;
- attempts to run cleanup in parallel;
- attempts to recover journal/spool state, admit work, prepare an attempt,
  create timers, execute a sandbox, or publish events.

## Delivery order

1. Commit ADR-057 and this plan before production code.
2. Add the two narrow ports, immutable result, and closed error type.
3. Implement the one-shot sequential recovery state machine.
4. Add ordering, concurrency, invalid-result, and failure-injection tests.
5. Run all local and GitHub Actions gates before admitting ADR-057.

## Exit criteria

1. Source recovery cannot begin before sandbox recovery succeeds.
2. Every reported count came from a successful exact-owner port call.
3. Duplicate callers cannot duplicate cleanup or introduce cancellation.
4. Any partial or uncertain recovery keeps the startup gate closed.
5. No durable state or attempt capability is deleted or reconstructed here.
6. Work admission, execution, events, and production runner remain disabled.
7. Full repository, native durability, browser, build, and CI gates pass.

## Evidence

Implementation commit `0b7d64e`; GitHub Actions run `30659524149` passed 262
runner-local tests, all PostgreSQL/API/runner integrations, both native
durability probes, the Chromium product journey, and production builds. Local
format, type, lint, Phase 1/2 boundary audit, workspace test, and build gates
also passed.
