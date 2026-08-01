# Slice 2.33 publication authority checkpoint

Status: Complete

Date: 2026-08-01

Architecture: ADR-045, ADR-053, ADR-054, ADR-063, ADR-068, ADR-069, ADR-070

## Outcome

Add one authenticated, serialized authority checkpoint for terminal
publication eligibility without stopping the lease monitor, reading a local
clock, or composing an executable runner session.

## Monitor checkpoint contract

`LeaseAuthorityMonitor.checkpoint()` returns a frozen union:

- `renewed` with the authenticated server `leaseExpiresAt` preserved as opaque
  evidence;
- `cancelled` with the exact directive and termination receipt;
- `stale` when the exact fence has lost authority.

It rejects with the monitor's existing bounded uncertainty errors. A request
after sealed owner stop rejects with fixed `monitor_stopped`; no cached renewal
is replayed as current authority.

## Cadence integration

- a checkpoint before start joins the initial immediate heartbeat;
- a checkpoint during an in-flight heartbeat joins that exact operation;
- a checkpoint during scheduled wait aborts only the wait and triggers one
  immediate heartbeat;
- concurrent checkpoint requests share the same current or next heartbeat and
  the same frozen result object;
- normal cadence resumes only after an authenticated renewal;
- cancelled, stale, and uncertain outcomes settle both the main monitor and all
  checkpoint waiters consistently;
- stop during an in-flight checkpoint lets the heartbeat settle, while stop
  before an unstarted checkpoint rejects it without a new heartbeat.

No checkpoint may overlap a heartbeat or compare `Date.now()` with either lease
timestamp.

## Arbiter amendment

Replace `TerminalAuthorityObservation.state: "stopped"` with `"renewed"` and
the authenticated opaque `leaseExpiresAt`. Renewed preserves trusted runtime or
local-failure candidates and returns `candidate_missing` for none. All
cancellation, stale, uncertainty, exact identity, receipt, duration, and
contradiction rules remain unchanged.

`stopped` remains only the monitor's post-completion owner result and is invalid
arbiter input.

## Failure matrix

- checkpoint before start, during heartbeat, during wait, and after renewal;
- concurrent and sequential checkpoint requests;
- checkpoint crossed with renewed, cancelled, stale, heartbeat uncertainty,
  scheduler uncertainty, revocation failure, and owner stop;
- no overlapping supervisor calls under adversarial scheduling;
- no cached renewal after stop or terminal monitor state;
- checkpoint output mutation and server-response mutation;
- arbiter renewed crossed with runtime, local-failure, and missing candidates;
- explicit rejection of stopped arbiter observations;
- proof that no clock, publication, journal, spool, or runner loop is reachable.

## Delivery order

1. Commit ADR-070 and this plan before production code.
2. Define the checkpoint result and stopped-error contracts.
3. Integrate checkpoint waiters into the single-flight monitor cadence.
4. Replace stopped with renewed in terminal arbitration.
5. Add deterministic cadence, concurrency, stop, mutation, and arbiter tests.
6. Run every local and GitHub Actions gate before admitting ADR-070.

## Exit criteria

1. Publication eligibility requires one authenticated serialized heartbeat.
2. Checkpoints never overlap or rely on local time.
3. Concurrent callers share one frozen authority result.
4. Premature or sealed stop cannot manufacture authority.
5. Arbiter no longer accepts stopped as pre-publication authority.
6. Publication, session composition, polling, and runner enablement remain
   disabled.

## Validation

Implementation commit `9636848` passed formatting, type checking, linting,
both architecture audits, every repository test and build, and the low-severity
dependency audit. The focused proof comprises 26 lease-authority monitor tests
and 39 terminal-outcome arbiter tests; the complete runner-local suite contains
485 passing tests. GitHub Actions run `30709048533` independently passed the
PostgreSQL, authenticated API, runner, Linux native durability, Chromium
product-journey, and production-build gates.
