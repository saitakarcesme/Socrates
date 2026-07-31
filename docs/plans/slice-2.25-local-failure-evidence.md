# Slice 2.25 closed local failure evidence policy

Status: Planned

Date: 2026-07-31

Architecture: ADR-037, ADR-045, ADR-055, ADR-060, ADR-061, ADR-062

## Outcome

Create one deterministic, redacted policy that converts only trusted local
attempt failures or authenticated cancellation into valid terminal event
drafts, without composing or enabling a runner session.

## Input taxonomy

Define a strict discriminated input union with:

- runner-owned stage and closed failure code;
- whether the durable execution-start barrier was crossed;
- non-negative safe elapsed duration where required;
- a validated server cancellation directive only for cancellation.

Supported local stages cover projection, source resolution, image admission,
source materialization, request materialization, sandbox invocation, runtime
protocol validation, cleanup, and unexpected runner failure. Adapter-specific
errors are classified at their boundary before entering the policy.

## Output policy

Return exactly one frozen `RunnerEventDraft` for evidence-producing inputs:

- local failures become `task.failed` with a fixed classification and
  product-authored message;
- a trusted cancellation directive becomes `task.cancelled` with bounded
  duration and explicit forced state;
- exact budget classification includes exactly one contract budget dimension.

Never copy arbitrary error text, stack, cause, host path, command, credential,
or cancellation reason into the draft.

## No-evidence outcomes

Return an explicit `no_evidence` decision for transport ambiguity, event
rejection, spool corruption/capacity, acknowledgement mismatch, work-journal
corruption, and completion uncertainty. These failures occur at or after a
durable evidence boundary and must be retried or reconciled rather than
translated into a competing terminal event.

## Failure matrix

- every closed stage/code pair and unknown pair rejection;
- pre-start and post-start applicability;
- zero, fractional, negative, unsafe, and excessive durations;
- forged or malformed cancellation directives;
- budget classification without or with multiple dimensions;
- arbitrary secret/path text supplied as nested causes;
- mutation attempts against inputs and returned drafts;
- transport/spool/journal ambiguity producing no draft;
- output validation against the V2 runner event contract.

## Delivery order

1. Commit ADR-062 and this plan before production code.
2. Define the closed input and decision contracts.
3. Implement the pure redacted mapping through `runnerEventDraft`.
4. Add exhaustive table, property, mutation, and secret-leakage tests.
5. Export the policy only from the lifecycle boundary.
6. Run all local and GitHub Actions gates before admitting ADR-062.

## Exit criteria

1. Arbitrary exception content can never enter terminal evidence.
2. Every evidence-producing input yields exactly one valid terminal draft.
3. Cancellation requires authenticated directive authority.
4. Ambiguous post-evidence failures produce no competing draft.
5. Mapping is deterministic, frozen, and dependency-free.
6. Session composition, persistence, execution, and runner enablement remain
   disabled.
