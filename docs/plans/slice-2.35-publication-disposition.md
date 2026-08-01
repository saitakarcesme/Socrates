# Slice 2.35 publication disposition

Status: Implemented

Date: 2026-08-01

Architecture: ADR-045, ADR-056, ADR-057, ADR-058, ADR-060, ADR-063, ADR-069,
ADR-070, ADR-071, ADR-072

## Outcome

Make every publication dependency failure observable as an exact read-only
durable disposition before a future session changes lease-monitor ownership.
Do not add retry, abandonment, reconciliation, or a runnable session.

## Disposition contract

Add a deeply frozen `TerminalPublicationDisposition` union:

- `absent` with the exact active work state;
- `pending` with active work plus positive pending count and exact
  acknowledged/last sequence counters;
- `acknowledged` with active work and a fully acknowledged terminal cursor;
- `completed` with completed work and its matching acknowledged terminal cursor.

Every state is bound to one parsed delivery and execution. Counters are safe
integers and must satisfy `pending = last - acknowledged`. Pending and
acknowledged dispositions require exactly one terminal batch. Completed also
requires the work completion sequence to equal the terminal acknowledgement.

## Failure boundaries

Publication dependency failures are labelled only as:

1. `recovery_before_append` while inspecting or draining existing evidence;
2. `append` while committing the new immutable terminal batch;
3. `recovery_after_append` while draining, acknowledging, or completing after
   append.

The label is fixed by coordinator control flow, never inferred from exception
text or Promise settlement order. Caller validation, identity conflict,
completed-evidence mismatch, and non-publishable work remain existing fatal
errors.

## Read-only audit

After a dependency exception, inspect the work journal, claimed execution, and
existing spool state. The audit:

- repeats exact execution-digest and delivery identity checks;
- treats no spool and a valid empty manifest as `absent`;
- validates terminal and cursor invariants before pending/acknowledged output;
- validates completion sequence against the spool before completed output;
- performs no recovery call and reaches no sender, appender, acknowledger,
  completion writer, monitor, scheduler, or wall clock;
- rejects audit failure or impossible combinations as
  `publication_state_uncertain` with both causes retained only in memory.

If the audit proves completed after a lost response, return the existing
`completed/recovered` success. Otherwise throw a single frozen
`TerminalEvidencePublicationDeferredError` with boundary and disposition. The
error message and disposition contain no dependency message, path, token, or
response body. Audit failure throws a separate frozen
`publication_state_uncertain` error while retaining the original fixed
boundary and both causes only in memory.

## Failure matrix

- each of the three boundaries throws synchronously and rejects asynchronously;
- append fails before manifest, after empty manifest, after segment, and after
  commit publication;
- sender fails before submission, after server acceptance, and before local
  acknowledgement;
- acknowledgement persistence fails before and after replacement;
- completion fails before commit and after durable commit;
- absent spool, empty spool, pending terminal, fully acknowledged terminal, and
  completed work;
- retired, rejected, missing, identity-drifted, digest-drifted, non-terminal,
  counter-drifted, and completion-sequence-drifted state;
- audit journal and spool failures crossed with every primary boundary;
- concurrent and sequential publication calls remain serialized;
- disposition, work, counters, errors, and caller input resist mutation;
- proof that audit cannot append, send, acknowledge, complete, heartbeat, stop,
  abandon, acquire, or poll.

## Delivery order

1. Commit ADR-072 and this plan before production code.
2. Add the strict disposition contract and read-only auditor.
3. Attach auditing to the three existing publication dependency boundaries.
4. Return recovered completion when the audit proves the postcondition.
5. Add failure-injection, impossibility, concurrency, and mutation tests.
6. Run every local and GitHub Actions gate before admitting ADR-072.

## Exit criteria

1. Every dependency failure has one fixed publication boundary.
2. Every trusted audit yields exactly one immutable durable disposition.
3. Lost completion responses return normal recovered success.
4. Impossible or unauditable state never produces a guessed disposition.
5. Failure causes remain in memory and never enter product evidence.
6. No retry, monitor ownership change, polling loop, or runner is enabled.

## Admission evidence

Implementation commit `2066567` passed all local repository gates, including
46 focused disposition/publication tests and all 544 runner-local tests. The
focused suites prove exact absent, pending, acknowledged, and completed states;
fixed failure boundaries; lost-response recovery; audit fail-closed behavior;
deep immutability; serialized duplicates; and read-only inspection of real
durable journal/spool state without a second append.

Main CI run `30711001656` passed formatting, type checks, lint, both dependency
boundary audits, PostgreSQL migration and seed, workspace and integration
tests, native spool and work-journal durability, the Chromium product journey,
production builds, and evidence upload. ADR-072 is admitted with retry,
monitor abandonment, reconciliation-order changes, session composition,
acquisition polling, and runner enablement still excluded.
