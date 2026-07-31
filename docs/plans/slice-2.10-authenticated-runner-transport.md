# Slice 2.10 authenticated runner transport plan

Status: Complete

Date: 2026-07-31

Architecture: ADR-031, ADR-035, ADR-037, ADR-038, ADR-046, ADR-047

## Outcome

Expose a disabled-by-default authenticated HTTP boundary for exact runner
claim, heartbeat/cancellation observation, and one-at-a-time durable event
delivery. Add the corresponding typed Node client and spool sender without
starting a runner loop or OCI execution.

## Research basis

- Hono supports asynchronous bearer verification and typed custom middleware;
  Socrates needs the latter so a verified runner principal reaches handlers.
- Node 22 provides stable built-in `fetch` plus timeout and signal composition;
  the adapter can remain dependency-light and inject the fetch boundary in
  tests.
- Existing Socrates ADR-031 makes the transactional outbox the task-delivery
  boundary. Transport therefore claims a known task ID and does not invent an
  unrelated queue scanner.

Primary references:

- <https://hono.dev/docs/middleware/builtin/bearer-auth>
- <https://hono.dev/docs/guides/middleware>
- <https://nodejs.org/api/globals.html>

## Boundary

The slice adds four independently testable pieces:

1. strict versioned runner HTTP request/response contracts;
2. a persistence-backed bearer authenticator returning a bound runner
   principal;
3. Hono routes that inject the principal into `RunnerGatewayService`;
4. an outbound Node client plus a sequential sender that advances the existing
   durable spool only after exact acknowledgement validation.

The slice does not add task discovery, an outbox dispatcher, a broker, a
background poller, heartbeat scheduling, retry backoff, OCI execution, source
materialization, automatic cancellation, token-management HTTP routes, or a
production runner feature flag.

## Wire protocol

All endpoints require `Authorization: Bearer <opaque-token>`, JSON request
bodies, strict schemas, and bounded bytes.

```text
POST /v1/runner/tasks/:taskId/claims
  request:  { version: "1", attemptId, leaseDurationMs }
  response: { version: "1", execution: RunnerExecutionV1 }

POST /v1/runner/tasks/:taskId/attempts/:attemptId/heartbeat
  request:  { version: "1", fence, leaseDurationMs }
  response: { version: "1", leaseExpiresAt, directive: "continue" | "cancel" }

POST /v1/runner/events
  request:  { version: "1", event: RunnerEventV2 }
  response: { version: "1", replay, acknowledgement: RunnerEventAcknowledgementV1 }
```

Path IDs, body IDs, principal identity, and event-envelope identity must agree
where they overlap. Dates are RFC 3339 strings. No response includes the token
selector, workspace ID, raw database state, or internal host path.

The initial ceilings are part of configuration and contracts, not middleware
defaults. Requests with absent or invalid JSON media type, trailing structure,
or bodies above the ceiling fail before an application transaction. Responses
are also bounded and validated by the client.

## Authentication and provisioning

Add `runner_registration_tokens` with:

- token UUID selector as primary key;
- runner registration foreign key;
- fixed lowercase SHA-256 digest of the 32-byte random secret;
- expiry, optional revocation, creation timestamp, and optional operator label;
- indexes for active runner rotation and expiry maintenance.

The external token has the fixed form `srt1.<uuid>.<base64url-secret>`. Parsing
is closed and length-bounded. A private credential repository selects one
candidate by token ID and evaluates expiry/revocation using PostgreSQL time; it
returns the fixed-size digest and runner/workspace binding only to the
authenticator, never through a route or public diagnostic. The authenticator
decodes the supplied secret, hashes it, and always performs `timingSafeEqual`
against either the stored digest or a fixed dummy digest. Invalid cases
collapse to one result.

An operator-only TypeScript command generates 32 random bytes, inserts only the
digest and metadata, and prints the complete token once after commit. It
requires explicit runner ID and expiry arguments, refuses overwrite, and never
logs the token through shared diagnostics. Tests provision random ephemeral
tokens; no usable credential enters fixtures or Git.

## Scheduler changes

Extend heartbeat persistence so the same fenced, unexpired update returns both
the database-clocked lease expiry and whether the task projection is
`cancellation_requested`. The public application result maps that fact to a
closed directive. A stale heartbeat remains a conflict and reveals no task
state.

`RunnerGatewayService` gains heartbeat and keeps claim/event ingestion as the
only application entry points. It receives authenticated runner identity from
the route adapter. Exact claim and event replay remain successful. No route
calls repositories directly.

## Client and sender semantics

The runner transport client:

- accepts an immutable base URL, bearer credential, operation timeout, response
  byte ceiling, and injected fetch implementation;
- rejects URL credentials, fragments, query strings, and non-HTTPS URLs unless
  explicit insecure development mode is configured;
- sets JSON/accept headers, disables redirects, composes caller and timeout
  signals, and performs exactly one fetch per method call;
- reads a bounded response stream, validates the shared success or error
  schema, and classifies ambiguous network failure separately from an
  authoritative response;
- redacts credentials and raw bodies from every thrown error.

The spool sender asks for the first pending envelope for one opened attempt,
sends it, verifies that acknowledgement and replay metadata match the envelope,
and calls the durable spool acknowledgement operation. It stops after the first
failure and never skips, pipelines, regenerates, or locally synthesizes an
acknowledgement.

## Retry and failure policy

The transport adapter does not sleep or retry. A later coordinator may retry:

- claim only with the same task ID and attempt ID;
- heartbeat only with the same task, attempt, and fence while the previous
  database lease may still be valid;
- event delivery only with the exact immutable spooled envelope.

Unauthorized, invalid protocol, identity conflict, stale fence, and local
acknowledgement mismatch are terminal for that coordinator decision. Timeout,
connection loss, and server failure are ambiguous and preserve the spool and
attempt identity for bounded backoff.

## Security and adversarial matrix

- missing, duplicated, malformed, oversized, expired, revoked, and wrong-secret
  bearer credentials;
- token for another runner/workspace combined with valid task and event IDs;
- constant response shape for unknown selector, unknown runner, and wrong
  digest;
- route disabled when persistence or authenticator is absent;
- wrong media type, empty/truncated/oversized JSON, prototype-shaped keys, and
  response-body bombs;
- path/body/principal/event ID disagreement;
- exact claim replay after a lost response and attempt-ID conflict;
- heartbeat renewal, cancellation directive, stale fence, lease expiry, and
  cancellation race;
- accepted event, exact replay, gap, budget exhaustion, stale fence, and
  terminal replay acknowledgement;
- redirect, timeout, caller abort, connection reset, invalid content type,
  malformed error body, and credential-redaction proofs;
- sequential spool delivery, crash before/after response, acknowledgement
  mismatch, and restart replay;
- dependency audit proving API routes cannot import runner code and runner
  transport cannot import database or API internals.

## Delivery order

1. Add shared strict transport contracts and compatibility fixtures.
2. Add token schema, migration, repository port, provisioning primitive, and
   PostgreSQL authentication tests.
3. Extend fenced heartbeat to return the cancellation directive atomically.
4. Extend `RunnerGatewayService` and its exhaustive error mapping tests.
5. Add typed authentication middleware, byte-bounded JSON parsing, runner
   routes, readiness state, and Hono tests.
6. Add the single-attempt Node transport client with adversarial response and
   abort tests.
7. Add the one-event spool sender and restart/ambiguity tests.
8. Run full local gates, PostgreSQL integration gates, and CI before amending
   ADR-047 with immutable validation evidence.

## Exit criteria

1. No enabled runner route can execute without a valid, unexpired, unrevoked
   credential bound to the exact runner principal.
2. No request body can choose its authorized runner or workspace.
3. Claim replay, heartbeat renewal/directive, and event replay preserve the
   existing transactional scheduler semantics.
4. The client never accepts unbounded or schema-invalid control-plane bytes.
5. The sender advances the spool only for the exact durable acknowledgement.
6. Ambiguous transport failure preserves the same task, attempt, fence, event,
   and spool state for later retry.
7. Task discovery and retry scheduling remain absent and injectable.
8. `LocalRunnerNotEnabledError` remains the production entry-point behavior.
9. Full repository, real PostgreSQL, and CI gates pass before the slice becomes
   Complete.

## Validation

Completed on 2026-07-31.

- local formatting, typecheck, lint, unit/adversarial tests, Phase 1 and Phase 2
  dependency audits, production builds, and low-severity dependency audit
  passed with no known vulnerabilities;
- contracts passed 39 tests, runner authentication passed 4 tests, API passed
  55 local tests, and runner-local passed 159 local tests;
- GitHub Actions run `30647374933` applied schema compatibility 6 and passed all
  database, API, runner, native spool, browser, and build gates;
- the real PostgreSQL transport journey passed missing-auth rejection, exact
  claim, continue/cancel heartbeat directives, terminal acknowledgement, and
  exact replay;
- the real filesystem sender proof preserved pending evidence across ambiguous
  network failure and rejected mismatched acknowledgement before advancement;
- task delivery, retry scheduling, the lease coordinator, OCI execution, and
  production runner enablement remain explicitly out of scope.
