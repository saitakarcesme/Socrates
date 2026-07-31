# Slice 2.29 pre-start terminal evidence recovery

Status: Planned

Date: 2026-07-31

Architecture: ADR-045, ADR-052, ADR-060, ADR-061, ADR-065, ADR-066

## Outcome

Recover and durably complete terminal evidence belonging to claimed work
before that attempt can become ready for execution after a restart.

## Admission contract

For a durable `claimed` work item:

1. load its exact frozen execution;
2. run existing terminal evidence recovery before returning `ready`;
3. return `completed` and end the call when recovery completes work;
4. return `ready` only when recovery reports no evidence;
5. propagate recovery ambiguity and suppress both execution and acquisition.

The `ready` result carries the journal-owned `deliveryId`, because later
terminal publication and completion cannot derive delivery identity from the
execution contract.

## Reuse boundary

Use ADR-065's existing non-creating inspection, bounded sender, and durable
completion coordinator unchanged. Do not add another replay loop or a special
pre-start spool format. Existing exact-empty state remains equivalent to no
evidence; any partial non-terminal, corrupt, or identity-conflicting state
fails closed.

## Failure matrix

- absent and exact-empty spool state returns ready without mutation;
- pending, partially acknowledged, and fully acknowledged terminal batches
  complete before ready;
- transport, acknowledgement, spool, and completion ambiguity suppress ready;
- successful recovery suppresses same-call acquisition;
- invalid or missing claimed execution fails closed;
- delivery identity is copied exactly into fresh and recovered ready results;
- concurrent admission calls preserve serialized one-at-a-time ordering.

## Delivery order

1. Commit ADR-066 and this plan before production code.
2. Add delivery identity to the ready admission result.
3. Invoke terminal recovery in the claimed path before ready.
4. Add deterministic restart, ambiguity, identity, and ordering tests.
5. Run all local and GitHub Actions gates before admitting ADR-066.

## Exit criteria

1. Claimed terminal evidence cannot be skipped by admission.
2. Ambiguity cannot release an attempt for execution.
3. Completion and acquisition remain separated across calls.
4. Ready results retain exact durable delivery identity.
5. Execution, fresh event creation, polling, and runner enablement remain
   disabled.
