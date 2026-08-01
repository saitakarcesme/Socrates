# Slice 2.30 terminal evidence publication

Status: Planned

Date: 2026-08-01

Architecture: ADR-045, ADR-048, ADR-052, ADR-060, ADR-065, ADR-066, ADR-067

## Outcome

Publish one validated terminal lifecycle batch through durable append, bounded
delivery, exact acknowledgement, and local work completion without opening a
duplicate-event retry path.

## Preflight contract

Before durable or remote effects:

1. parse and deeply freeze delivery ID, execution, and drafts;
2. require a non-empty batch ending with exactly one terminal event;
3. load the exact journal record and its durable claimed execution;
4. require byte-equivalent delivery, task, attempt, fence, and frozen task;
5. admit only claimed, execution-started, or exact completed replay state.

Invalid batches must not create an attempt manifest.

## Publication ordering

1. Recover existing exact terminal evidence through ADR-065.
2. Return recovered completion without append when evidence exists.
3. Reject completed work whose exact evidence cannot be recovered.
4. Revalidate active journal ownership before a fresh append.
5. Append exactly one terminal lifecycle segment.
6. Invoke ADR-065 recovery again and require durable completion.

Underlying spool, transport, acknowledgement, and completion ambiguity
propagates unchanged. A later call starts by recovering the same durable bytes.

## Result contract

Return one deeply frozen completed result with:

- the exact durable work state;
- `publication: "appended"` for a batch created by this call;
- `publication: "recovered"` for prior or concurrently completed evidence.

Generated event IDs and sequences are not returned as caller authority.

## Failure matrix

- invalid delivery, execution, draft payload, empty batch, multiple terminal
  events, and terminal-not-last input before filesystem mutation;
- missing, pending, rejected, retired, completed-without-evidence, and
  execution-conflicting work;
- absent and exact-empty spool followed by one append;
- existing pending, partially acknowledged, fully acknowledged, and completed
  terminal evidence without append;
- append fault before and after durable segment/commit publication;
- sender transport and acknowledgement ambiguity;
- completion publication ambiguity;
- recovery `none` after append as an invariant failure;
- concurrent duplicate calls producing one segment and one completion.

## Delivery order

1. Commit ADR-067 and this plan before production code.
2. Move spool draft/terminal validation before manifest creation.
3. Implement the publication coordinator from narrow journal, spool, and
   recovery ports.
4. Export it only through the work-journal boundary.
5. Add deterministic mutation, restart, ambiguity, identity, and concurrency
   tests.
6. Run every local and GitHub Actions gate before admitting ADR-067.

## Exit criteria

1. Invalid input produces no durable or remote side effect.
2. Existing exact evidence always wins over fresh mutation.
3. Fresh evidence is appended once and completed through ADR-065.
4. Every ambiguity preserves a later byte-stable recovery path.
5. Concurrent duplicate calls cannot allocate duplicate event identities.
6. Execution, session composition, polling, and runner enablement remain
   disabled.
