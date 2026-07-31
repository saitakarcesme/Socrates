# Slice 2.28 terminal evidence recovery before retirement

Status: Planned

Date: 2026-07-31

Architecture: ADR-045, ADR-048, ADR-052, ADR-060, ADR-061, ADR-065

## Outcome

Recover and durably complete already-spooled terminal evidence before an
execution-started attempt may enter lease retirement reconciliation.

## Non-creating inspection

Add `LocalEventSpool.inspectExisting(execution)`:

- return `null` without writes when the exact attempt directory is absent;
- validate and return the same frozen `SpoolState` when present;
- preserve every corruption, identity, checksum, and bounded-capacity check;
- never create a manifest as a side effect of recovery probing.

## Bounded recovery

`TerminalEvidenceRecoveryCoordinator.recover(deliveryId, execution)` returns:

- `none` for no spool or an empty exact manifest;
- `completed` only after all initially pending events receive exact durable
  acknowledgements and work completion is durably committed.

The coordinator sends exactly the initial pending count through
`SequentialSpoolSender`. Premature idle or completion `not_ready` is an
invariant error. Any transport or storage ambiguity propagates and preserves
the same pending evidence for later replay.

## Admission ordering

For `execution_started` work only:

1. recover existing terminal evidence;
2. return completed work and end the admission call when successful;
3. otherwise perform exact lease reconciliation as defined by ADR-061.

Never acquire another delivery in the same call that completes recovered work.
Do not inspect or recover pre-start claimed evidence in this slice.

## Failure matrix

- absent attempt without filesystem mutation;
- empty manifest, committed pending batch, partially acknowledged batch, and
  fully acknowledged terminal tombstone;
- non-terminal, corrupt, wrong-identity, and count-drift state;
- sender premature idle and each transport/acknowledgement failure;
- completion `not_ready`, identity conflict, and publication failure;
- restart after each event acknowledgement and completion fault boundary;
- proof recovery precedes reconciliation and suppresses it on ambiguity;
- proof successful completion suppresses same-call acquisition.

## Delivery order

1. Commit ADR-065 and this plan before production code.
2. Add non-creating exact spool inspection with tests.
3. Implement bounded terminal evidence recovery from existing ports.
4. Integrate recovery before execution-started reconciliation.
5. Add deterministic restart, ambiguity, ordering, and mutation tests.
6. Export only from the work-journal boundary.
7. Run all local and GitHub Actions gates before admitting ADR-065.

## Exit criteria

1. Recovery probing creates no spool state.
2. Existing terminal bytes are replayed before lease retirement.
3. Drain work is bounded by the first validated snapshot.
4. Completion requires exact durable terminal acknowledgement.
5. Ambiguity preserves evidence and prevents same-call reconciliation.
6. Successful recovery prevents same-call acquisition.
7. Execution, fresh event creation, polling, and runner enablement remain
   disabled.
