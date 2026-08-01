# Slice 2.32 terminal outcome arbitration policy

Status: Planned

Date: 2026-08-01

Architecture: ADR-045, ADR-060, ADR-062, ADR-063, ADR-068, ADR-069

## Outcome

Create one pure, deterministic policy that selects terminal evidence from a
trusted runtime or local-failure candidate and the final lease-authority
observation, without composing or enabling an executable runner session.

## Closed inputs

Bind every decision to one validated frozen `RunnerExecutionV1` and accept:

- execution timing as `not_started` or `started` with a non-negative safe
  integer elapsed duration supplied by the future owner;
- candidate state as one validated runtime terminal batch, one runner-owned
  `task.failed` draft, or `none`;
- authority as clean owner `stopped`, authenticated `cancelled` with the exact
  frozen termination receipt, `stale`, or redacted `uncertain`.

The arbiter accepts no Promise, exception, timestamp, lease-expiry value,
sandbox handle, journal, transport, publisher, or mutable callback.

## Precedence table

1. `stale` and `uncertain` always return closed `no_evidence` decisions.
2. Authenticated cancellation with `terminated` returns `task.cancelled` using
   the receipt's observed `forced` value and the supplied started duration.
3. A terminated receipt without durable execution start is contradictory and
   returns `no_evidence`.
4. Authenticated cancellation with `absent` preserves a complete runtime
   candidate because cancellation did not terminate that sandbox.
5. Authenticated cancellation with `absent` and no runtime candidate returns a
   non-forced cancellation; pre-start duration is exactly zero.
6. Clean owner `stopped` preserves a runtime or local-failure candidate.
7. Clean owner `stopped` without a candidate returns `no_evidence`.

Local failure never overrides an authenticated cancellation. A runtime batch
can win only against `absent`, never against observed termination, stale
authority, or authority uncertainty.

## Validation and output

- validate runtime candidates through `terminalRunnerEventDrafts`;
- require local failure candidates to contain exactly one `task.failed` draft;
- construct cancellation only through `localFailureEvidence` from the parsed
  authenticated directive and receipt;
- deeply freeze candidates, observations, and decisions;
- return only `evidence` with one complete terminal batch or `no_evidence` with
  a closed redacted reason;
- reject malformed external shapes before making a decision;
- never translate `no_evidence` into a competing terminal failure.

## Failure matrix

- every candidate crossed with stopped, cancelled-absent,
  cancelled-graceful, cancelled-forced, stale, and uncertain authority;
- pre-start and started cancellation with zero and maximum safe elapsed values;
- terminated-before-start and runtime-before-start contradictions;
- forged cancellation, malformed receipt, malformed draft, multiple terminal
  drafts, non-terminal runtime batch, and cancellation disguised as failure;
- mutation attempts against execution, input drafts, receipts, and outputs;
- proof that arbitrary uncertainty text and exception objects are not accepted;
- proof that no clock, timer, sandbox, filesystem, transport, or publication
  dependency is reachable.

## Delivery order

1. Commit ADR-069 and this plan before production code.
2. Define the closed input, decision, and redacted no-evidence contracts.
3. Implement the pure precedence table through existing lifecycle validators.
4. Export only from the lifecycle boundary.
5. Add exhaustive table, contradiction, mutation, and secret-leakage tests.
6. Run every local and GitHub Actions gate before admitting ADR-069.

## Exit criteria

1. Promise timing and local wall clocks cannot affect precedence.
2. Stale or uncertain authority can never create terminal evidence.
3. `forced: true` originates only from a terminated backend receipt; absence
   maps to the contractually non-forced pre-sandbox outcome.
4. Cancellation absence preserves only complete runtime evidence.
5. Every evidence result is a valid frozen terminal batch.
6. Session composition, side effects, polling, and runner enablement remain
   disabled.
