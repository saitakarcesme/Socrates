# Slice 2.43 fresh attempt session ownership

Status: Planned

Date: 2026-08-01

Architecture: ADR-057, ADR-063, ADR-067, ADR-069, ADR-070, ADR-071, ADR-072,
ADR-073, ADR-074, ADR-075, ADR-078, ADR-079, ADR-080

## Outcome

Compose one exact `ready` work-admission handoff into a closed attempt session
that owns heartbeat authority, local execution, deterministic arbitration, and
terminal publication until one terminal settlement. The component remains
unreachable from a production polling loop.

## Accepted handoff

`FreshAttemptSession` accepts only the exact deeply frozen shape:

```text
{
  state: "ready",
  deliveryId,
  execution,
  recovered: boolean
}
```

Unknown fields, invalid delivery IDs, invalid execution contracts, and task or
attempt identity drift fail before effects. Both a fresh claim and a recovered
claimed/absent handoff are valid because ADR-075 has already proved that neither
contains terminal durable evidence and the current server attempt remains
authoritative. `execution_started`, `recovery_pending`, `indeterminate`, and
all terminal admission states are rejected.

## Owned composition

From narrow capabilities and validated bounds, the session constructs:

1. one execution-bound `SandboxCancellationScope`;
2. one heartbeat-only `LeaseSupervisor` and `LeaseAuthorityMonitor`;
3. one durable journal start barrier and monotonic timing barrier;
4. one execution projector, preparation coordinator, and runtime executor;
5. one `AttemptExecutionObserver` using the cancellation scope signal;
6. one pure `TerminalOutcomeArbiter`;
7. one `TerminalEvidencePublicationCoordinator` using the same journal,
   terminal spool, and recovery port;
8. one bounded `TerminalPublicationOwner` only after an evidence decision.

The sandbox backend capability supplies both runtime execution and
exact-identity cancellation. The session accepts no prebuilt monitor, observer,
arbiter, publication owner, event IDs, wall clock, acquisition source, or
polling callback. Construction has no effects.

## Settlement ordering

1. start the authority monitor and immediately observe its Promise;
2. begin local observation only after heartbeat invocation has started;
3. await the closed local observation and all local cleanup ownership;
4. request one serialized authority checkpoint;
5. convert only renewed, cancelled, stale, or fixed redacted monitor
   uncertainty into ADR-069 authority input;
6. decide through the pure arbiter without promise or local-clock ordering;
7. for `evidence`, publish only the decided drafts through ADR-074;
8. for `no_evidence`, invoke ADR-078 release and never construct publication;
9. await the original monitor operation with the selected owner path;
10. return only after exact terminal settlement consistency is proven.

The checkpoint lease-expiry string remains opaque. A renewed checkpoint does
not stop cadence and does not bypass transactional control-plane fencing.

## Result contract

Evidence success returns the existing immutable
`TerminalPublicationOwnershipResult`. Its authority must exactly equal the
monitor result.

No-evidence success returns an immutable result containing the exact closed
decision reason and authority state. Only `released` with
`terminal_evidence_unavailable`, authenticated `cancelled`, or `stale` is
valid. `stopped`, `abandoned`, malformed, contradictory, or detached authority
is a fixed session consistency error.

Monitor heartbeat, scheduler, or revocation uncertainty remains a rejection;
the session must await it and preserve causes only in memory behind a fixed
public error. Publication-owner failures retain their existing redacted
taxonomy only after monitor settlement. No error path may continue polling or
start another attempt.

## Failure matrix

- fresh and recovered ready handoffs plus every rejected handoff shape and
  identity drift;
- construction without heartbeat, clock, journal, source, image, request,
  sandbox, spool, recovery, or publication effects;
- initial heartbeat pending, renewed, cancelled, stale, synchronous rejection,
  asynchronous rejection, malformed response, and scheduler failure;
- cancellation before preparation, during source/image/request work, during
  sandbox execution, after runtime completion, and during cleanup;
- runtime success/failure, every typed local failure, cleanup failure,
  pre-start observation, and ADR-079 timing uncertainty;
- checkpoint renewed/cancelled/stale/heartbeat/scheduler/revocation outcomes;
- evidence append, recovery-before/after-append, pending and acknowledged
  retry, completion, exhaustion, abandonment, and release races;
- every no-evidence reason with released/cancelled/stale/uncertain authority;
- publication completion racing a later cancellation or stale heartbeat;
- concurrent and sequential `settle()` calls, dependency mutation, fixed
  messages, cause redaction, deep immutability, and terminal result equality;
- real journal/spool/control-plane recovery proving successful evidence is
  durable and no-evidence performs no append, send, acknowledgement, complete,
  retirement, or new event-ID effect.

## Delivery order

1. Commit ADR-080 and this plan before production code.
2. Add strict ready-handoff and result contracts.
3. Extract shared authority-result equality from restart session composition.
4. Construct every execution-bound collaborator from narrow capabilities.
5. Implement authority-first settlement and evidence/no-evidence branches.
6. Add adversarial ordering, identity, failure, and real durable-store tests.
7. Run every local and GitHub Actions gate before admitting ADR-080.

## Exit criteria

1. Authority starts before any local execution effect.
2. No event can append without an exact post-observation checkpoint decision.
3. No-evidence can invoke only ADR-078 release and never publication.
4. Every supported settled path leaves no source, request, sandbox, monitor, or
   publication ownership detached.
5. Promise order and local lease-time interpretation cannot affect policy.
6. No startup root, acquisition, polling, backoff, concurrency scheduler, or
   runner enablement is added.
