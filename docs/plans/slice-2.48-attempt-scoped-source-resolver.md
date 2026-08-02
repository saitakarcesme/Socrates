# Slice 2.48 attempt-scoped source resolver factory

Status: Admitted

Date: 2026-08-02

Architecture: ADR-056, ADR-058, ADR-080, ADR-082, ADR-085

## Outcome

Correct the local attempt composition boundary so every fresh attempt owns a
distinct source resolver authorized for its exact parsed lease identity.

## Capability contract

`ExecutionSourceArtifactResolver` carries:

- one deeply frozen `SandboxAttemptIdentity`;
- one `resolve({ snapshotId, digest, signal? })` operation.

`ExecutionSourceArtifactResolverFactory.create(identity)` returns that narrow
capability. Identity always originates from the coordinator's parsed
`RunnerExecutionV1`, never a process config field or resolver response.

## Preparation order

1. Construct the coordinator without invoking the factory.
2. Project the immutable execution plan.
3. Reject pre-cancellation before factory creation.
4. Call the captured factory exactly once with derived identity.
5. Require an object with exact frozen identity and callable `resolve`.
6. Snapshot identity and capture `resolve` before transport.
7. Continue the admitted source resolution, image admission, and
   materialization order unchanged.

Factory throw or invalid output becomes fixed `invalid_artifact_resolver` and
causes no later preparation effect.

## Owner and concrete factory

`LocalAttemptOwnerOptions` accepts `artifactResolvers`, not one `artifacts`
resolver. The owner captures `create`, validates every result, and retains a
weak identity set so one resolver object cannot be issued twice. Fresh session
composition receives this exact factory; restart-only publication never asks
for a resolver.

`BoundedSourceArtifactResolverFactory` validates one positive maximum archive
size and captures the source transport's `open` plus artifact store's `put`
methods during inert construction. Every create call returns a new
`BoundedSourceArtifactResolver` with an independently frozen exact identity,
signal authority, operation, result, and failure.

## Adversarial matrix

- inert coordinator, owner, and concrete factory construction;
- invalid/missing/throwing factory method and post-construction mutation;
- factory not called for pre-aborted preparation;
- exact runner/task/attempt/fence identity derivation and deep freezing;
- malformed resolver, missing resolve, mutable identity, extra identity keys,
  and every identity-field drift;
- factory throw before source/image/materialization effects;
- one factory call for concurrent/repeated prepare;
- two sequential owner attempts receive distinct resolver objects and exact
  independent identities;
- owner rejects resolver object reuse before a second resolve;
- concrete factory dependency getter/method faults and mutation;
- independent resolver snapshot/digest/signal authority and retained failure;
- real `RunnerHttpClient` plus local artifact store resolution for two attempt
  identities without cross-attempt transport authority.

## Delivery order

1. Commit ADR-085 and this plan before production code.
2. Add identity-bearing resolver and factory contracts.
3. Defer exact factory creation into first preparation.
4. Replace owner resolver capture with factory capture and reuse detection.
5. Add the concrete bounded resolver factory and dependency capture.
6. Update fresh-session composition and all strict tests.
7. Run every local and GitHub Actions gate before admitting ADR-085.

## Exit criteria

1. No resolver authority can be shared across fresh attempt sessions.
2. Resolver identity is exact, immutable, and derived only from execution.
3. Factory failure or invalid output precedes every source transport effect.
4. One preparation creates at most one resolver.
5. Concrete resolvers retain independent signal/result/failure authority.
6. Existing source bounds, digest verification, and cancellation semantics do
   not weaken.
7. No environment loader, resource process root, signal handler, shutdown
   owner, or runner enablement lands.

## Admission evidence

- Architecture commit: `08660c6`.
- Implementation commit: `91629b4`.
- Focused additions: 22 adversarial tests covering exact immutable identity,
  every identity-field drift, inert and retained factory authority, malformed
  capabilities, cross-attempt reuse rejection, dependency mutation and getter
  faults, distinct sequential resolver issuance, and real two-attempt
  `RunnerHttpClient` plus local artifact-store resolution.
- Runner-local suite: all 944 tests passed against fresh migrated PostgreSQL
  database `socrates_ci_adr085`.
- Local gates: Phase 1 and Phase 2 boundary audits, formatting, typecheck,
  lint, full workspace tests, database and API integrations, Chromium
  measured-research E2E, and production build. Native durability validations
  are Linux-only and passed in CI.
- GitHub Actions: run `30725526404` passed all required Linux, PostgreSQL, API,
  runner, native durability, Chromium journey, production-build, and
  evidence-upload gates.
