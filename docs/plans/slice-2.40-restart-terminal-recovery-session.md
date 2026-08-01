# Slice 2.40 restart terminal recovery session

Status: Complete

Date: 2026-08-01

Architecture: ADR-057, ADR-063, ADR-073, ADR-074, ADR-075, ADR-076, ADR-077

## Outcome

Compose the exact `recovery_pending` handoff into one closed session that owns
lease supervision and recovery-only terminal publication through a terminal
result. The component remains unreachable from a production polling loop.

## Owned composition

`RestartTerminalRecoverySession` binds one validated and deeply frozen
ADR-075 handoff. From narrow dependencies it constructs:

1. an execution-bound `SandboxCancellationScope`;
2. a heartbeat-only `LeaseSupervisor`;
3. one `LeaseAuthorityMonitor`;
4. one append-free `RecoveryOnlyTerminalPublication`;
5. one bounded `TerminalPublicationOwner`.

The session accepts no drafts, spool appender, event identity source, wall
clock, execution observer, work admission port, or acquisition port. The
control-plane dependency exposes heartbeat only. Constructor validation
requires the exact `recovery_pending` shape, `recovered: true`, claimed or
execution-started work, delivery/task/attempt continuity, a valid execution,
and valid server observation timestamps. Construction performs no heartbeat,
audit, recovery, cancellation, or release effect.

## Settlement ordering

`settle()` is single-flight and follows this order:

1. start the exact authority monitor and attach observation to its Promise;
2. invoke the bounded publication owner only after monitor startup;
3. let ADR-076 audit and recover only existing terminal evidence;
4. let ADR-074 checkpoint every retained pending retry and retry acknowledged
   evidence locally;
5. await both ownership and authority settlement;
6. return only when the owner and monitor terminal evidence agree;
7. propagate a bounded owner failure only after authority has also settled;
8. fail closed on contradictory, malformed, or detached settlement.

Promise settlement order is not policy. Reconciliation timestamps are opaque
evidence, not local lease authority. No path stops authority before durable
completion, converts cancellation into invented evidence, or falls through to
fresh append.

## Failure matrix

- malformed handoff shape, recovered flag, active state, delivery, task,
  attempt, execution, and timestamp drift;
- initial heartbeat renewed, cancelled, stale, synchronous rejection,
  asynchronous rejection, and malformed dependency output;
- publication completed, pending, acknowledged, absent, inconsistent,
  uncertain, and recovery exhaustion;
- checkpoint cancellation/stale/uncertainty during retained pending recovery;
- clean stop, abandonment, revocation, and release uncertainty;
- publication-completion versus heartbeat terminal races;
- concurrent and sequential `settle()` calls;
- dependency mutation, fixed public messages, in-memory cause preservation,
  and exact terminal result agreement;
- real durable pending and acknowledged journal/spool recovery through the
  composed owner with counters proving no append.

## Delivery order

1. Commit ADR-077 and this plan before production code.
2. Narrow `LeaseSupervisor` to the heartbeat capability it actually uses.
3. Add strict recovery-pending handoff validation.
4. Implement the closed restart recovery session composition.
5. Add adversarial ordering, race, release, identity, and durable-store tests.
6. Run every local and GitHub Actions gate before admitting ADR-077.

## Exit criteria

1. The session starts authority before any recovery publication effect.
2. One exact execution binds heartbeat, cancellation, audit, recovery, and
   completion.
3. Every settled path proves the monitor is terminal; no detached rejection or
   scheduled heartbeat remains.
4. Existing pending/acknowledged evidence can complete without append
   capability or a new event ID.
5. No fresh execution, polling loop, backoff, startup orchestration, or runner
   enablement is added.

## Admission evidence

Implementation commit `a49fb60` introduced the closed restart recovery session
and narrowed `LeaseSupervisor` to a heartbeat-only control-plane capability.
All 31 focused session tests passed, covering strict handoff validation,
construction without effects, heartbeat-before-audit ordering, pending and
acknowledged ownership, authenticated cancellation, stale/uncertain authority,
scheduler and revocation failure, bounded exhaustion, in-flight release,
single-flight settlement, mutation, and redaction. Real restarted pending and
acknowledged journal/spool cases prove the composition cannot append or invent
an event.

The complete runner-local suite passed with 727 tests, and every locally
applicable repository gate passed, including the PostgreSQL-backed Chromium
measured-research journey. GitHub Actions run `30716554709` passed formatting,
type checking, lint, Phase 1/2 dependency audits, PostgreSQL migration and seed,
workspace/database/API/runner tests, Linux native spool and work-journal
durability, Chromium product journey, production build, and evidence upload.
ADR-077 is admitted without enabling execution, startup orchestration, polling,
or the runner.
