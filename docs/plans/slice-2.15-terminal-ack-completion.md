# Slice 2.15 terminal acknowledgement completion plan

Status: Planned

Date: 2026-07-31

Architecture: ADR-046, ADR-048, ADR-051, ADR-052

## Outcome

Bind terminal control-plane acknowledgement in the durable event spool to an
append-only work-journal completion record, allowing restart-first admission
to move past completed work without deleting evidence.

## Boundary

Add a completion record and closed `completed` journal state, a narrow spool
inspection port, and a one-shot completion coordinator. Do not execute work,
produce or send events, heartbeat, cancel, loop, retry, compact, or delete.

## Authority and state

```text
pending_claim -> claimed -> completed
pending_claim -> rejected(control_plane_conflict)
```

Completion requires all of:

- a byte-equivalent durable journal claim;
- spool `terminal=true`;
- `pendingEvents=0`;
- positive `lastSequence`;
- `acknowledgedSequence=lastSequence`;
- the spool attempt key derived from the same frozen execution.

Completion and rejection are mutually exclusive. Manifest, claim, and
completion remain immutable diagnostic evidence.

## Failure policy

- missing claim, execution mismatch, attempt-key mismatch, terminal/rejection
  conflict, malformed record, and conflicting replay fail closed;
- absent/incomplete/unacknowledged spool evidence returns `not_ready` without
  journal mutation;
- a fault before immutable completion publication leaves claimed work;
- a fault after publication recovers completed work;
- completed and rejected history is skipped by later admission;
- pending or claimed work continues to block acquire.

## Adversarial matrix

- no spool lifecycle batch;
- committed terminal batch with pending events;
- partially acknowledged batch;
- exact final terminal acknowledgement;
- non-terminal or contradictory spool state;
- wrong execution, attempt key, delivery, and sequence;
- claim/rejection/completion mutual exclusion;
- idempotent completion replay and conflicting replay;
- all immutable publication fault boundaries;
- restart before and after publication;
- completed history followed by one new acquire;
- concurrent completion and admission calls fail closed or serialize through
  durable state without early acquire;
- native private mode, single-link, and restart recovery;
- unchanged `LocalRunnerNotEnabledError`.

## Delivery order

1. Commit ADR-052 and this plan before production code.
2. Add completion schema, codec, filesystem, and journal state transition.
3. Add the one-shot completion coordinator and admission filtering.
4. Add unit, fault-boundary, restart, integration, and native tests.
5. Run all local and GitHub Actions gates before admitting ADR-052.

## Exit criteria

1. Only exact terminal acknowledgement can complete local work.
2. Completion cannot precede or replace a durable claim.
3. Completion and rejection cannot coexist.
4. Incomplete evidence never opens acquire.
5. Completed evidence survives restart and allows later acquisition.
6. No evidence is automatically deleted or rewritten.
7. Crash recovery is monotonic at every publication boundary.
8. Execution, supervision, cancellation, and production entry remain absent.
9. Full repository, native durability, browser, build, and CI gates pass.
