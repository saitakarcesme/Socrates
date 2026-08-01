# Slice 2.39 recovery-only terminal publication

Status: Planned

Date: 2026-08-01

Architecture: ADR-065, ADR-072, ADR-074, ADR-075, ADR-076

## Outcome

Create the fixed publication operation required by an ADR-075
`recovery_pending` handoff. It may recover and complete existing durable
terminal evidence, but it has no drafts and no append capability.

## Capability boundary

`RecoveryOnlyTerminalPublication` binds:

- one validated delivery ID;
- one deeply frozen execution;
- the existing bounded terminal recovery port;
- the read-only terminal disposition auditor over exact journal and spool read
  capabilities.

Its constructor receives no event drafts, event ID source, clock, spool
appender, or generic sender. `publish()` is serialized and repeatable so the
ADR-074 owner can invoke the same fixed operation after each prescribed
authority decision. The publication primitive does not own retry count or
lease release.

## State ordering

For every invocation:

1. audit exact work, claimed execution, and durable disposition before effects;
2. return audited completed evidence as recovered success without probing;
3. reject audited absent evidence without invoking recovery;
4. invoke bounded recovery only for pending or acknowledged evidence;
5. re-audit and validate an asserted completed recovery result;
6. on recovery rejection, re-audit the exact disposition;
7. convert post-failure completed evidence to recovered success;
8. defer post-failure pending/acknowledged evidence at boundary
   `recovery_only`;
9. classify `none`, malformed, contradictory, or drifting recovery output as
   inconsistent rather than retryable;
10. aggregate audit uncertainty with the primary failure only in memory.

No path receives an append port, and no failure changes from recovery to fresh
publication.

## Failure matrix

- initial work: claimed, execution-started, completed, retired, rejected,
  pending-claim, and absent;
- recovery: completed, none, synchronous rejection, asynchronous rejection,
  malformed result, identity drift, state drift, and acknowledgement drift;
- post-failure audit: absent, pending, acknowledged, completed, rejection,
  malformed output, and uncertainty;
- exact delivery/task/attempt/execution continuity and mutable dependency
  outputs;
- concurrent and sequential invocation serialization;
- fixed/redacted public messages and in-memory cause preservation;
- real durable acknowledged, partially pending, completed-replay, and absent
  spool restarts with event IDs and spool counters proving no append.

## Delivery order

1. Commit ADR-076 and this plan before production code.
2. Add the append-free recovery publication contract and fixed error taxonomy.
3. Reuse the existing auditor/deferred/state-uncertain contracts without
   weakening their invariants.
4. Add identity, state, acknowledgement, immutability, and serialization tests.
5. Add real durable journal/spool restart tests that prove no new append.
6. Run every local and GitHub Actions gate before admitting ADR-076.

## Exit criteria

1. The component type has no drafts or append dependency.
2. Existing terminal evidence can complete through the standard publication
   result consumed by ADR-074.
3. Pending and acknowledged ambiguity preserves exact disposition for bounded
   owner retry.
4. Missing, drifting, malformed, or uncertain evidence never creates an event.
5. No monitor, attempt session, fresh publication, polling loop, or runner is
   enabled.
