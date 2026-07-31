# Slice 2.21 bounded source artifact resolution

Status: Planned

Date: 2026-07-31

Architecture: ADR-044, ADR-056, ADR-058

## Outcome

Resolve one frozen source reference into a genuine local `VerifiedArtifact`
through an attempt-authorized streaming transport and the existing bounded
content-addressed artifact store.

## Boundary

Add a process-local `BoundedSourceArtifactResolver` to runner-local's `source`
module. Construction binds an exact `SandboxAttemptIdentity`, an explicit
positive maximum archive byte count, a narrow source transport, and an
`ArtifactStore`.

The resolver can expose the existing `ExecutionSourceArtifactResolver` shape.
It cannot know HTTP, bearer tokens, URLs, redirects, filesystem paths, task
journal state, source extraction, image admission, runtime requests, OCI,
events, or timers.

## Resolution protocol

1. Validate constructor identity and maximum before any operation.
2. The first call freezes `(snapshotId, digest, signal)` as its authority.
3. Reject malformed or later-drifted snapshot/digest/signal before I/O.
4. Ask the transport to open the exact identity-bound source stream.
5. Accept only `application/vnd.socrates.source-snapshot.v1+tar`.
6. Accept only a positive safe declared size within the trusted maximum.
7. Stream into `ArtifactStore.put` with exact expected digest and size.
8. Check cancellation before transport, after transport, per chunk, and after
   store verification.
9. Revalidate the returned genuine artifact capability and exact identity.

## One-shot semantics

- exact concurrent/later calls share one promise;
- failure is retained and never causes an implicit redownload;
- a later caller cannot replace the first signal;
- different snapshot or digest input rejects independently without touching
  the authoritative operation;
- no response body is accumulated by the resolver;
- the artifact store owns atomic staging and content-addressed replay.

## Failure matrix

- invalid bound or attempt identity;
- malformed snapshot identifier or digest before transport;
- snapshot/digest drift on a later call;
- signal-authority drift on a later call;
- pre-aborted, mid-stream, and post-verification cancellation;
- transport rejection or missing snapshot;
- wrong media type;
- zero, negative, fractional, unsafe, `NaN`, infinite, or over-policy size;
- stream shorter or longer than declared;
- stream digest mismatch;
- forged or identity-drifted artifact returned by the store;
- concurrent calls duplicate transport/store work;
- attempts to buffer bytes, accept paths/URLs, retry, materialize, persist
  capabilities, call HTTP directly, or execute work.

## Delivery order

1. Commit ADR-058 and this plan before production code.
2. Add exact descriptor/transport/error types.
3. Implement one-shot authority checks and cancellation-aware streaming.
4. Delegate atomic size/digest verification to `ArtifactStore.put`.
5. Add adversarial, mutation, concurrency, and streaming property tests.
6. Run all local and GitHub Actions gates before admitting ADR-058.

## Exit criteria

1. Only exact attempt-authorized bytes can become a verified artifact.
2. No source response can exceed the trusted archive bound.
3. No complete response body is buffered by the resolver.
4. Duplicate or drifted callers cannot duplicate or replace authority.
5. Cancellation cannot return a verified capability.
6. Task schemas, HTTP routes, extraction, and execution remain unchanged.
7. Full repository, native durability, browser, build, and CI gates pass.
