# Slice 2.41 no-evidence authority release

Status: Complete

Date: 2026-08-01

Architecture: ADR-063, ADR-069, ADR-070, ADR-073, ADR-074, ADR-075, ADR-078

## Outcome

Add the terminal authority result required when a future fresh attempt session
has completed local observation but deterministic arbitration produces no
terminal evidence. The operation closes monitor ownership without pretending
that work completed or terminal publication failed.

## Contract

`LeaseAuthorityMonitor.releaseWithoutEvidence()` is an owner-only release
operation. After an already-started monitor has no remaining local execution
capability to supervise, it may settle as:

```text
{ state: "released", reason: "terminal_evidence_unavailable" }
```

The result is distinct from `stopped`, `abandoned`, `cancelled`, and `stale`.
It creates no control-plane request, event, journal record, retirement, or
completion. The future session will be responsible for proving ADR-071 cleanup
and selecting the operation only from a frozen ADR-069 `no_evidence` decision.

## Ordering

1. The first release intent remains final and repeatable.
2. A scheduled heartbeat wait is aborted without sending another heartbeat.
3. An in-flight heartbeat is allowed to settle before release completes.
4. In-flight cancellation and stale authority outrank evidence-free release.
5. Heartbeat, scheduler, and revocation failures retain fail-stop rejection.
6. A renewed in-flight heartbeat permits the fixed released result.
7. A checkpoint joined to an in-flight heartbeat settles from that heartbeat.
8. A queued or later checkpoint that cannot run before release rejects with
   fixed `monitor_released`.

No local timestamp is read or interpreted. Evidence-free release does not
revoke a sandbox itself; invoking it before local observation cleanup remains a
future session composition error rather than a capability supplied here.

## Publication-owner isolation

ADR-074 accepts only `stopped`, `cancelled`, or `stale` after completed
publication. Only `abandoned` represents successful publication abandonment;
`cancelled` and `stale` remain terminal errors there. `released` is valid in
neither set. Tests must prove that a release race through `stop()`,
`abandonPublication()`, or `checkpoint()` becomes the existing fixed
conflict/terminal error rather than successful completion or abandonment.

## Failure matrix

- release before start, during the first heartbeat, during scheduled wait, and
  after terminal monitor settlement;
- renewed, cancelled, stale, heartbeat rejection, scheduler rejection, and
  revocation rejection while release is requested;
- concurrent release callers and competing stop/abandon intents;
- pending and later checkpoints around release;
- publication success, fatal failure, and retained pending recovery racing a
  released monitor;
- malformed terminal results, fixed public errors, cause preservation, and
  deep immutability;
- exact proof that release sends no new heartbeat and invokes no revocation.

## Delivery order

1. Commit ADR-078 and this plan before production code.
2. Extend the closed authority result and release-intent state machine.
3. Add the fixed post-release checkpoint error.
4. Preserve ADR-074 result sets and test release conflicts explicitly.
5. Add adversarial monitor ordering and no-side-effect tests.
6. Run every local and GitHub Actions gate before admitting ADR-078.

## Exit criteria

1. No-evidence release cannot be mistaken for durable completion.
2. No-evidence release cannot be mistaken for publication abandonment.
3. In-flight authoritative or uncertain outcomes outrank local release.
4. No clean release creates an event, journal mutation, revocation, or new
   heartbeat; an already in-flight failure retains its existing revocation.
5. No arbiter, fresh session, polling loop, or runner enablement is added.

## Admission evidence

Implementation commit `f716f67` introduced the distinct immutable
`terminal_evidence_unavailable` result and the first-intent
`releaseWithoutEvidence()` transition. ADR-074 keeps exact successful result
sets, so released authority fails closed through existing completion,
abandonment, and checkpoint conflict paths instead of acquiring publication
meaning.

Fifteen focused tests passed across the authority monitor and terminal
publication owner. They cover release before start and during scheduled or
in-flight work; renewed, cancelled, stale, heartbeat, scheduler, and revocation
outcomes; joined and queued checkpoints; competing intents; already-terminal
monitors; immutable results; fixed redacted errors; and publication success,
fatal failure, and pending recovery encountering released authority. Counters
prove clean release sends no heartbeat, invokes no revocation, and performs no
publication-owner success transition.

The complete runner-local suite passed with 744 tests against a fresh
PostgreSQL database. Every locally applicable repository gate passed,
including the Chromium measured-research journey and production build. GitHub
Actions run `30717770398` passed formatting, type checking, lint, Phase 1/2
dependency audits, PostgreSQL migration and seed, workspace/database/API/runner
tests, Linux native spool and work-journal durability, Chromium product
journey, production build, and evidence upload. ADR-078 is admitted without
adding arbitration, a fresh attempt session, polling, backoff, or runner
enablement.
