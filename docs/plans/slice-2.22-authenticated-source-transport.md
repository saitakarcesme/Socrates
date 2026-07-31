# Slice 2.22 authenticated fenced source transport

Status: Complete

Date: 2026-07-31

Architecture: ADR-033, ADR-039, ADR-044, ADR-058, ADR-059

## Outcome

Serve and consume a source snapshot stream only after bearer authentication,
exact active-lease authorization, immutable catalog lookup, and local
content-addressed object verification.

## Persistence

Add a forward-only `source_snapshots` catalog with:

- UUID snapshot identity;
- lowercase SHA-256 digest referencing `artifact_objects`;
- positive safe byte length matching the artifact object;
- canonical `application/vnd.socrates.source-snapshot.v1+tar` media type;
- immutable creation timestamp.

Advance schema compatibility only after the table, constraints, foreign key,
and lookup index exist. No migration mutates existing task JSON.

Add one scheduler query that accepts exact runner/task/attempt/fence/source
identity and returns immutable metadata only when:

- the runner owns the attempt;
- the attempt is the task's current fence and is leased;
- the lease is unexpired at database time;
- the task is executable V2 and still leased;
- frozen payload source identity matches the request;
- the catalog row matches both snapshot and digest.

## API

Add a validated `POST
/v1/runner/tasks/:taskId/attempts/:attemptId/source-snapshots/resolve` request
containing version, positive fence, snapshotId, and digest.

The existing bearer middleware supplies runner identity. The application
service owns database authorization. On success the route verifies the exact
catalog object through `ArtifactStore`, opens a one-shot bounded read, and
returns its stream with exact `Content-Type` and `Content-Length`. Redirects,
range requests, content negotiation, and caller-selected media types are not
supported.

## Runner transport

Extend `RunnerHttpClient` with an ADR-058-compatible `open` operation. It:

- validates attempt/source identity before fetch;
- sends the existing bearer credential only to the configured origin;
- uses manual redirect mode and exact POST JSON;
- distinguishes caller abort, timeout, auth, conflict, missing, protocol, and
  server failures;
- validates exact media type and positive bounded `Content-Length` before
  returning;
- exposes a single-consumption async iterable over response chunks;
- counts chunks and aborts on the configured source transport maximum;
- never accumulates the archive into a complete buffer.

## Failure matrix

- schema constraint, migration-order, and compatibility drift;
- missing/disabled gateway or artifact store;
- absent, malformed, or wrong runner bearer credential;
- malformed params/body, zero/unsafe fence, snapshot, or digest;
- runner, task, attempt, fence, lease, status, or frozen-source mismatch;
- missing catalog row or artifact-object metadata mismatch;
- catalog row with absent, changed, or unverifiable local object;
- non-200 response, redirects, wrong/missing media type or content length;
- zero, negative, fractional, unsafe, or over-policy response length;
- empty, truncated, oversized, replayed, or failing response body;
- pre-fetch, header-time, and mid-stream cancellation/timeout;
- response buffering, credential forwarding, path disclosure, range serving,
  source extraction, or execution dependencies.

## Delivery order

1. Commit ADR-059 and this plan before production code.
2. Add schema compatibility migration and catalog/query ports.
3. Implement transactional gateway authorization and unit/integration tests.
4. Add the authenticated bounded streaming route.
5. Implement non-buffering runner HTTP transport and adversarial tests.
6. Integrate transport with ADR-058 resolver in a full boundary test.
7. Run all local and GitHub Actions gates before admitting ADR-059.

## Exit criteria

1. Only the current exact fenced lease can authorize its frozen source.
2. Database metadata and local object bytes are independently verified.
3. Neither API nor runner buffers the complete archive.
4. Redirects and cross-origin credential forwarding are impossible.
5. Every byte path is bounded and cancellation-aware.
6. Task schemas and durable task JSON remain unchanged.
7. Source upload, extraction, execution, and runner enablement remain off.
8. Full PostgreSQL, API, runner, native, browser, build, and CI gates pass.

## Validation

Implementation commit `94e1a25` and integration-fixture correction `1fd11b8`
passed local formatting, type, lint, dependency-boundary, workspace-test, and
production-build gates. GitHub Actions run `30662277227` passed PostgreSQL 17
migration and integration tests, authenticated API source streaming and
cancellation revocation, 295 runner-local tests, both Linux native durability
probes, the Chromium journey, and all production builds.
