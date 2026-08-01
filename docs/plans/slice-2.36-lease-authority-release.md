# Slice 2.36 lease-authority release

Status: Planned

Date: 2026-08-01

Architecture: ADR-063, ADR-069, ADR-070, ADR-071, ADR-072, ADR-073

## Outcome

Represent the semantic difference between clean lease-monitor release after
durable completion and fail-stop abandonment after unrecoverable terminal
publication. Add a pure publication-to-authority policy, but do not compose a
session or retry publication.

## Monitor contract

Extend the frozen `LeaseAuthorityResult` with:

```text
{ state: "abandoned", reason: "terminal_publication_failed" }
```

Add one explicit abandonment request beside `stop()`. Both requests:

- are idempotent and return the monitor's existing single-flight promise;
- prevent all future heartbeat scheduling;
- wake a scheduled heartbeat delay immediately;
- allow one already in-flight heartbeat to settle;
- never invoke local sandbox revocation by themselves.

The first owner-release intent wins. Cancellation, stale authority, supervisor
uncertainty, scheduler failure, and revocation failure still outrank either
intent when already observed. A renewal that races release cannot schedule
another wait or heartbeat. A checkpoint after clean stop remains
`monitor_stopped`; a checkpoint after abandonment is `monitor_abandoned`.

## Pure publication policy

Add a side-effect-free, exhaustive decision over an explicit `fulfilled` or
`rejected` settlement of ADR-072. The policy never races or awaits a Promise and
retains neither the fulfilled work value nor rejected reason:

- completed publication -> `stop`;
- deferred pending -> `retain`;
- deferred acknowledged -> `retain`;
- deferred absent -> `abandon`;
- publication-state uncertainty -> `abandon`;
- every other fatal publication failure -> `abandon`;
- deferred completed -> reject as impossible.

The returned decision is deeply frozen and contains no original error text or
cause. The policy accepts no monitor, journal, spool, transport, scheduler,
clock, or sandbox dependency.

## Failure matrix

- stop and abandonment before `start`, during scheduled wait, and during an
  in-flight heartbeat;
- stop/abandon and abandon/stop order, concurrent duplicates, and later calls;
- renewal, cancellation, stale, supervisor failure, scheduler failure, and
  revocation failure crossed with a selected owner release;
- checkpoint before, during, and after each terminal state;
- exact proof that owner release creates no heartbeat after selection and no
  revocation call;
- every publication disposition and fatal class, invalid deferred completion,
  mutable caller input, deep freeze, and redaction.

## Delivery order

1. Commit ADR-073 and this plan before production code.
2. Refactor monitor stop state into a first-wins release intent.
3. Add explicit terminal-publication abandonment and checkpoint semantics.
4. Add the pure exhaustive publication authority policy.
5. Add adversarial race, precedence, mutation, and no-effect tests.
6. Run every local and GitHub Actions gate before admitting ADR-073.

## Exit criteria

1. Clean release and abandonment are observably distinct.
2. No owner release can create a post-release heartbeat.
3. Authority loss and uncertainty cannot be masked by owner release.
4. Publication evidence maps to exactly one frozen authority decision.
5. No dependency cause enters a result or policy decision.
6. No retry, reconciliation, session, polling loop, or runner is enabled.
