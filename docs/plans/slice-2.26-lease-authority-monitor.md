# Slice 2.26 fail-stop lease authority monitor

Status: Complete

Date: 2026-07-31

Architecture: ADR-045, ADR-053, ADR-054, ADR-061, ADR-062, ADR-063

## Outcome

Create one deterministic, single-attempt heartbeat cadence that stops local
work whenever lease authority becomes stale or uncertain, without composing or
enabling an executable runner session.

## Cadence contract

- bind the monitor to one validated frozen `RunnerExecutionV1`;
- heartbeat immediately before any scheduled wait;
- allow only one in-flight heartbeat;
- schedule the next step only after an authenticated renewal;
- require a positive safe-integer interval no greater than one third of the
  requested lease duration;
- use an injected abort-aware scheduler, never wall-clock lease comparison.

## Closed outcomes

- `cancelled`: the one-step supervisor applied the authenticated server
  directive;
- `stale`: the exact fence lost authority and local execution was revoked;
- `stopped`: the owner ended a scheduled wait after durable terminal
  acknowledgement and work completion;
- rejection: authority or scheduling became uncertain and local execution was
  revoked before a bounded monitor error escaped.

## Local revocation

Extend the identity-bound sandbox cancellation scope with a separate
idempotent local revocation operation. It aborts first and then stops only its
owned sandbox with a trusted local grace period. It shares termination state
with authenticated cancellation so concurrent commands cannot apply conflicting
policies or target the backend more than once.

Local revocation is operational containment. It never exposes a cancellation
directive and never authorizes `task.cancelled` evidence.

## Failure matrix

- initial, scheduled, and overlapping start/stop calls;
- interval zero, unsafe, fractional, and above one-third of lease duration;
- renewal followed by cancellation, stale authority, or every thrown failure;
- stop during wait and stop during an in-flight heartbeat;
- revocation before backend stop and backend-stop uncertainty;
- authenticated cancellation racing local revocation;
- duplicate equivalent operations and conflicting termination policy;
- proof that lease timestamps and wall clocks never drive authority;
- proof that no lifecycle draft, spool write, or work completion occurs.

## Delivery order

1. Commit ADR-063 and this plan before production code.
2. Define the scheduler, revocation, result, and error contracts.
3. Add idempotent local revocation to the sandbox cancellation scope.
4. Implement the single-flight immediate-first heartbeat monitor.
5. Add deterministic cadence, race, failure, and mutation tests.
6. Export only from the supervision boundary.
7. Run all local and GitHub Actions gates before admitting ADR-063.

## Exit criteria

1. No local timestamp grants or extends lease authority.
2. Heartbeats never overlap and the first request is immediate.
3. Stale or uncertain authority aborts local work before backend stop.
4. Authenticated cancellation remains distinct from local revocation.
5. Normal owner stop cannot discard an in-flight heartbeat outcome.
6. No terminal evidence is invented by supervision failure.
7. Session composition, execution, persistence, and runner enablement remain
   disabled.

## Validation

Implementation commit `c400b14` passed local formatting, TypeScript, ESLint,
Phase 1/2 dependency-boundary audits, 364 runner-local tests, all workspace
tests, production builds, and the low-severity dependency audit. Sixteen
focused monitor tests covered invalid timing policy, immediate-first cadence,
single-flight heartbeats, stop during wait and in-flight work, cancellation and
stale races, every uncertainty path, redaction, revocation failure aggregation,
and sealed replay. Expanded cancellation-scope tests covered bounded local
policy, abort-before-backend ordering, duplicate joining, policy conflict, and
authenticated/local termination races. GitHub Actions run `30666995698` passed
every PostgreSQL, authenticated API, and runner integration, both Linux native
durability probes, Chromium, and all production builds.
