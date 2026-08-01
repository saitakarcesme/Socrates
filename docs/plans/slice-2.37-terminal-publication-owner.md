# Slice 2.37 terminal publication owner

Status: Planned

Date: 2026-08-01

Architecture: ADR-067, ADR-069, ADR-070, ADR-072, ADR-073, ADR-074

## Outcome

Own one fixed terminal publication operation through bounded recovery and exact
lease-monitor release. Do not compose execution observation, arbitration,
restart reconciliation, acquisition, or a runnable session.

## One-shot contract

Construct `TerminalPublicationOwner` with:

- one zero-argument publication operation already bound to validated immutable
  delivery, execution, and terminal drafts;
- one authority port exposing checkpoint, clean stop, and publication
  abandonment;
- an explicit `maximumRecoveryAttempts` safe integer from zero through one
  hundred.

`complete()` is single-flight and returns the same Promise for concurrent and
later calls. The initial publication call is always allowed and does not consume
a recovery retry. Every later publication call consumes exactly one configured
retry. No scheduler, clock, jitter, implicit default, or unbounded mode exists.

## Recovery policy

Classify each explicit fulfilled/rejected settlement through ADR-073:

- `stop`: request clean stop once and return frozen completed publication plus
  the actual stopped/cancelled/stale monitor result;
- `retain` with acknowledged disposition: retry immediately because no remote
  event remains pending;
- `retain` with pending disposition: request a new checkpoint and retry only for
  `renewed`;
- `abandon`: request publication abandonment once and fail with a fixed redacted
  owner error;
- retain after the retry limit: request abandonment once and fail as
  `recovery_exhausted`.

The first retained disposition pins work identity and terminal last sequence.
Every later retained disposition must keep those values, advance acknowledgement
monotonically, reduce pending by the exact inverse delta, and never move from
acknowledged back to pending. Drift is `disposition_regressed` and abandons
without another retry.

A pending checkpoint returning cancellation or stale ends without another
publish or abandonment call. A checkpoint rejection retains the monitor cause
and also ends without a competing release request. Restart recovery owns the
durable pending batch after this process loses authority.

## Completion and release

After durable publication success, clean stop is requested exactly once.
Stopped, cancellation, and stale results all return completed success because
the durable postcondition already exists. Cancellation and stale details remain
in memory in the frozen result. Stop rejection throws
`completion_release_uncertain` with the completion retained in memory.

An abandoned result after clean stop or a stopped result after abandonment is
`release_conflict`. If abandonment itself rejects, retain the publication cause
and monitor cause in one in-memory `AggregateError`; never concatenate either
message. Returned results and owner errors are deeply frozen and redacted.

## Failure matrix

- initial success plus stopped, cancelled, stale, abandoned, and rejected clean
  release;
- acknowledged recovery success, repeated deferral, fatal retry, and exhaustion;
- pending recovery with renewed, cancelled, stale, and rejected checkpoints;
- valid pending-to-acknowledged progress plus identity, last-sequence, cursor,
  and acknowledged-to-pending regression;
- absent, publication-state uncertainty, every fatal publication error, and
  unknown rejection;
- abandonment success, release conflict, cancellation/stale race, and failure;
- zero and maximum retry bounds, invalid configuration, synchronous throw,
  asynchronous rejection, concurrent duplicates, later re-entry, mutation, and
  redaction;
- proof that acknowledged recovery makes no checkpoint, pending recovery makes
  one checkpoint per retry, and no path uses a scheduler, clock, acquire, poll,
  reconciliation, observation, or arbitration dependency.

## Delivery order

1. Commit ADR-074 and this plan before production code.
2. Add the one-shot owner contract and frozen result/error types.
3. Implement bounded acknowledged and checkpointed pending recovery.
4. Implement exact clean-stop, abandonment, and authority-terminal handling.
5. Add the full race, exhaustion, mutation, redaction, and no-effect matrix.
6. Run every local and GitHub Actions gate before admitting ADR-074.

## Exit criteria

1. One owner can create at most the configured number of recovery attempts.
2. Pending evidence never retries without a fresh renewed checkpoint.
3. Acknowledged evidence never performs an unnecessary authority heartbeat.
4. Completion, fatal failure, authority loss, and exhaustion release exactly
   once through their prescribed path.
5. Concurrent or later callers cannot duplicate publication or release.
6. No restart reconciliation, session, polling loop, or runner is enabled.
