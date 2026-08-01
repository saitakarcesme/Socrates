# Slice 2.38 restart evidence triage

Status: Complete

Date: 2026-08-01

Architecture: ADR-061, ADR-065, ADR-066, ADR-072, ADR-074, ADR-075

## Outcome

Triage recovered claimed and execution-started work by its exact durable
terminal disposition before choosing local completion, lease reconciliation,
or session handoff. Do not construct a monitor or attempt session.

## Admission evidence port

Provide `WorkAdmissionCoordinator` with one explicit terminal-evidence port that
offers:

- read-only `audit(deliveryId, execution)` from ADR-072;
- bounded `recover(deliveryId, execution)` from ADR-065.

The coordinator never infers disposition from an exception and never probes by
calling recovery. Audit occurs only for recovered active work; a fresh claim
created in the same serialized call cannot already own terminal spool evidence.

## State ordering

For recovered `claimed` or `execution_started` work:

1. load and verify the exact durable execution;
2. audit disposition;
3. return completed immediately for `completed`;
4. invoke recovery only for `acknowledged`, require completed output, and return
   it without reconciliation;
5. reconcile `pending` before any sender call;
6. reconcile `absent` according to claimed/started state.

Pending plus current reconciliation returns `recovery_pending` with frozen
delivery ID, execution, work, `observedAt`, and `leaseExpiresAt`. Pending plus
retired reconciliation commits exact retirement and leaves the spool unchanged.
No pending restart path calls the sender in this slice.

Absent recovered claimed work reconciles before ready. Current returns ready;
retired commits retirement. Absent execution-started work keeps the existing
current-indeterminate or retired result. Freshly claimed work remains ready
without redundant reconciliation.

## Failure matrix

- claimed and execution-started crossed with absent, pending, acknowledged, and
  completed dispositions;
- current and every retired reconciliation reason for pending and absent;
- audit failure, acknowledged recovery failure, recovery none/non-completed,
  reconciliation failure, and retirement failure;
- work/execution identity drift before audit and disposition work drift after
  audit;
- concurrent and sequential prepare calls, mutable audit outputs, and frozen
  result handoff;
- exact call-order proof and proof that acknowledged never reconciles, pending
  never recovers/sends, retired never becomes ready, and no terminal path
  acquires in the same call;
- real durable journal/spool restart for acknowledged local completion and
  pending current handoff with unchanged spool counters.

## Delivery order

1. Commit ADR-075 and this plan before production code.
2. Replace the recovery-only dependency with explicit audit plus recovery.
3. Add completed/acknowledged local paths and consistency checks.
4. Add pending and recovered-claimed reconciliation paths.
5. Add order, failure, immutability, and real-store restart tests.
6. Run every local and GitHub Actions gate before admitting ADR-075.

## Exit criteria

1. Restart disposition is read without side effects before path selection.
2. Acknowledged evidence completes locally without reconciliation.
3. Pending evidence cannot reach sender recovery before a supervised session.
4. Recovered claimed work cannot become ready without current reconciliation.
5. Retired work is durably closed and never released or acquired over.
6. No monitor, session, polling loop, or runner is enabled.

## Admission evidence

Implementation commit `f69c2af` passed every locally applicable repository
gate, including 41 restart-triage tests and all 659 runner-local tests. The
focused suites cover claimed and execution-started work across all four durable
dispositions, current and all six retired reconciliation results, call order,
failure propagation, consistency checks, mutation resistance, frozen handoff,
and real journal/spool restarts for acknowledged and pending evidence.

Main CI run `30713739060` passed formatting, type checks, lint, both dependency
boundary audits, PostgreSQL migration and seed, workspace and integration
tests, Linux native spool and work-journal durability, the Chromium product
journey, production builds, and evidence upload. ADR-075 is admitted with
monitor construction, attempt-session composition, polling, and runner
enablement still excluded.
