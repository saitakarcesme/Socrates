# Slice 2.51 authenticated control-plane composition

Status: Admitted

Date: 2026-08-02

Architecture: ADR-047, ADR-056, ADR-084, ADR-086, ADR-087, ADR-088

## Outcome

Replace ADR-087's broad injected control-plane capability at the next root
boundary with one concretely configured authenticated HTTP client, without
introducing secret loading, OCI/image bootstrap, or runner activation.

## Inputs

`LocalRunnerAuthenticatedAttemptLifecycle` receives:

- an unknown ADR-086 non-secret configuration candidate;
- one unknown bearer-credential candidate supplied separately from config;
- one required fetch capability;
- the sandbox, image, scheduler, time, observer, journal identity, spool
  identity, and directory-sync capabilities already accepted by ADR-087.

Configuration is parsed before any other property is read. The credential is
then read once and validated against the existing runner bearer-token contract.
No environment, file, stdin, secret store, clock, or network operation supplies
either input in this slice.

## Owned graph

The wrapper privately constructs:

1. one `RunnerHttpClient` configured by the exact ADR-086 origin, timeout,
   response ceiling, and source archive ceiling plus the separate credential
   and required fetch capability;
2. one ADR-087 `LocalRunnerAttemptLifecycle` receiving that same client for
   every control-plane and source-snapshot operation;
3. one retained `run(signal)` operation and no other public state.

HTTPS remains mandatory. `allowInsecureHttp`, ambient fetch fallback, retry,
credential refresh, and alternate transport defaults are not admitted.

## Ordering and failures

1. Parse, detach, and freeze non-secret configuration.
2. Read and validate the credential once.
3. Capture and validate required fetch and remaining capability owners.
4. Construct the inert HTTP client.
5. Construct ADR-087 from the admitted snapshot and captured capabilities.
6. Freeze the opaque wrapper and retain only its run operation.

Public wrapper errors distinguish `invalid_configuration`,
`invalid_credential`, `invalid_dependency`, and `composition_failed` with
fixed messages. Causes remain private in memory. No invalid or partial graph is
returned or retried.

## Adversarial matrix

- malformed configuration before credential and every dependency getter;
- throwing credential getter and malformed token without token disclosure;
- missing, non-callable, proxy, and throwing fetch capability;
- throwing owner properties and dependency method getters after credential
  admission;
- caller mutation cannot replace credential, fetch, or another method;
- construction performs no fetch, filesystem, process, timer, clock, UUID,
  recovery, image, observer, or sandbox effect;
- wrapper and errors serialize without the raw credential;
- exact configured HTTPS origin and route, bearer header, request timeout,
  response bound, and source bound are used once without fallback;
- one real idle transport acquisition observes and delays cooperatively;
- one source-snapshot transport request shares the same authenticated client;
- invalid signal, pre-abort, concurrent/repeated run, and private abort reason;
- transport/startup/observation/delay failure remains fail-stop with one client
  and one lifecycle only.

## Delivery order

1. Commit ADR-088 and this plan before production code.
2. Add the authenticated lifecycle wrapper and fixed error contract.
3. Map the admitted transport/source fields once into `RunnerHttpClient`.
4. Add adversarial precedence, capture, redaction, and opacity tests.
5. Add real fake-fetch idle and source-transport integrations.
6. Audit that ambient authority, secret loading, OCI/image composition, process
   entry, shutdown, and activation did not land.
7. Run every local and GitHub Actions gate before admitting ADR-088.

## Exit criteria

1. Invalid non-secret configuration precedes every secret/dependency access.
2. Raw credential material is never public, serialized, or logged.
3. One exact authenticated client owns every control-plane/source operation.
4. Construction is inert and the wrapper exposes only one retained run.
5. Configuration and explicit injected inputs are the only authorities.
6. No loader, refresh, OCI/image bootstrap, process entry, shutdown owner,
   feature flag, or runner enablement lands.

## Admission evidence

Architecture commit `e1150cf` preceded production code. Implementation commit
`01c49fd` adds the frozen opaque authenticated lifecycle and one exactly mapped
HTTP client. Nineteen focused tests cover the adversarial matrix, configured
timeout and response/source ceilings, authenticated idle operation, and a real
measured source flow; the transport suite locks the strict heartbeat route and
body projection. The fake-runner PostgreSQL integration now owns an isolated
workspace graph, so parallel repository tests cannot mutate demo read-model
fixtures.

All 1,077 runner-local tests and every local format, type, lint, dependency-
audit, workspace-test, Chromium journey, and production-build gate passed with
fresh migrated PostgreSQL. Main CI run `30728698907` passed every PostgreSQL,
API, runner, Linux native durability, Chromium product-journey, production-
build, and evidence-upload gate. Credential loading and refresh, environment,
trusted image declarations, OCI/platform bootstrap, process entry, shutdown
ownership, feature flags, and runner activation did not land.
