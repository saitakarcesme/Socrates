# Slice 2.17 identity-bound sandbox cancellation scope plan

Status: Complete

Date: 2026-07-31

Architecture: ADR-035, ADR-044, ADR-053, ADR-054

## Outcome

Bind each frozen execution to one cancellation scope that closes the race
between a pre-start abort and active OCI sandbox termination, while preserving
the immutable server cancellation policy.

## Boundary

Add an in-memory local-runner scope and narrow OCI cancellation port. Do not
schedule heartbeats, acquire work, materialize sources, execute a runtime,
generate events, write spool or journal state, retry engine operations, or
enable the production runner.

## State model

```text
open --first exact command--> cancelling --backend settled--> cancelled
  \--identity/policy drift--> reject, remain open
```

The scope exists before preparation. It exposes a signal that is aborted
synchronously before the backend cancellation request. The first exact command
and its single promise are retained. Exact duplicate calls join that promise;
conflicting calls fail without a new side effect.

## Cancellation semantics

- command identity must equal the frozen execution lease exactly;
- command policy is validated but never rewritten locally;
- abort happens before the backend is consulted;
- backend `active=false` means cancellation won before sandbox publication;
- backend errors remain errors and are replayed to duplicate callers;
- cancellation never selects a sandbox by mutable task state or caller input.

## Adversarial matrix

- invalid execution and invalid cancellation schema;
- runner, task, attempt, and fence mismatch independently;
- exact reason, requested timestamp, and grace preservation;
- pre-start cancel aborts the future execution signal;
- active cancel passes exact identity and bounded grace to the backend;
- exact sequential and concurrent duplicate calls invoke backend once;
- conflicting policy after first command fails without a second backend call;
- backend false, rejection, and delayed settlement;
- cancellation ordering proves abort precedes backend invocation;
- no timer, transport, spool, journal, lifecycle, or production-entry import.

## Delivery order

1. Commit ADR-054 and this plan before production code.
2. Add the narrow backend port and identity-bound scope.
3. Add deterministic mismatch, ordering, deduplication, and failure tests.
4. Run all local and GitHub Actions gates before admitting ADR-054.

## Exit criteria

1. A cancellation accepted before sandbox publication cannot miss later start.
2. An active sandbox receives the exact durable grace period.
3. No command can target another runner, task, attempt, or fence.
4. The first policy is immutable across duplicate or conflicting calls.
5. One scope performs at most one backend cancellation operation.
6. Backend uncertainty is never hidden by a local retry or success result.
7. No session loop, execution, event, or production enablement lands.
8. Full repository, native durability, browser, build, and CI gates pass.

## Evidence

Implementation commit `c35bf7b`; GitHub Actions run `30656584157` passed 219
runner-local tests, all PostgreSQL/API/runner integrations, native spool and
journal durability, the Chromium product journey, and production builds.
Local format, type, lint, boundary audit, workspace test, and build gates also
passed.
