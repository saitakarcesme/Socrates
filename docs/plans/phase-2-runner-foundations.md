# Phase 2 — runner foundations

Status: In progress

Owner: Platform

Updated: 2026-07-31

## Outcome

Execute one operator-authored experiment in a disposable local OCI sandbox and
return measured, attributable evidence to the existing experiment timeline.

This phase builds an execution substrate. It does not build an agent, select a
model provider, generate hypotheses, or repeat experiments autonomously.

## Authorization boundary

The control-plane foundation may be implemented and tested with a deterministic
fake runner. A real sandbox adapter must remain disabled until:

1. the threat model and OCI-engine spike are reviewed;
2. runner authentication for the deployment mode is defined;
3. the acceptance gates in this plan have executable tests; and
4. `LOCAL_RUNNER_ENABLED=true` is set deliberately.

Direct host command execution is not an acceptable intermediate implementation.

## Scope

### Included

- versioned runner registration and capability contracts
- immutable task snapshots
- transactional task dispatch
- fenced leases, heartbeats, attempts, and retry policy
- idempotent ordered event ingestion
- durable cancellation
- bounded log ingestion and redaction
- artifact metadata and a content-addressed store port
- externally enforced resource budgets
- deterministic measurement handoff to the existing decision policy
- fake-runner integration coverage
- one explicitly enabled OCI local-runner adapter

### Excluded

- LLM or embedding providers
- hypothesis generation or experiment planning
- automatic next-experiment scheduling
- tree search or parallel research strategies
- browser or computer-use actions
- arbitrary external side effects
- cloud runners and multi-tenant pools
- production object-storage selection
- billing

## Invariants

1. The API and web processes never execute experiment commands.
2. A task references frozen source, metric, constraints, action, environment,
   and budget revisions.
3. A task has at most one current lease fence.
4. Every runner write carries runner, task, attempt, and fence identity.
5. Stale attempts cannot append evidence or complete a task.
6. Terminal task and attempt states are immutable.
7. Retry creates a new attempt; it never rewrites a failed attempt.
8. Retry is allowed only when the action contract declares it safe.
9. A cancellation request is durable before delivery to the runner.
10. Resource enforcement does not depend on cooperation from experiment code.
11. Network, credentials, and writable mounts are absent unless granted.
12. Logs and artifact metadata are size-bounded and treated as untrusted.
13. Measurement validation and final decision remain control-plane concerns.
14. Runner loss cannot lose already acknowledged evidence.

## Protocol model

### Registration

A registration advertises:

- runner ID and deployment identity
- runner kind and software version
- supported task and event protocol versions
- sandbox backend and platform
- structured capabilities
- capacity
- last heartbeat and drain state

Registration authentication is deployment-specific but hidden behind one port.
The initial local development mode may use a manually provisioned, hashed
bootstrap token. It must not silently trust loopback or caller-supplied runner
IDs.

### Task snapshot

`ExperimentTaskV2` replaces the Phase 0 placeholder before execution is enabled:

```ts
type ExperimentTaskV2 = {
  version: "2";
  taskId: string;
  runId: string;
  experimentId: string;
  source: {
    snapshotId: string;
    digest: string;
  };
  hypothesis: string;
  action: {
    kind: "command-sequence";
    revision: string;
    steps: ReadonlyArray<DeclaredCommand>;
    retrySafe: boolean;
  };
  measurement: {
    metricDefinitionId: string;
    protocolRevision: number;
    command: DeclaredCommand;
  };
  constraints: ReadonlyArray<FrozenConstraint>;
  environment: {
    imageDigest: string;
    capabilities: ReadonlyArray<RunnerCapability>;
  };
  budget: RunnerBudget;
};
```

Commands are argument arrays with an explicit working directory and timeout;
they are not interpolated shell strings. Shell interpretation, if ever needed,
must be a separately granted capability visible in the UI and audit record.

### Task and attempt states

```text
task:    queued -> leased -> running -> succeeded
                    |          |-----> failed
                    |          |-----> cancelled
                    |          `-----> cancellation_requested
                    `---------------> cancelled

attempt: claimed -> preparing -> executing -> measuring -> succeeded
                   |          |           |-----------> failed
                   `----------+-----------------------> cancelled
```

`cancellation_requested` is non-terminal. The first valid fenced terminal
compare-and-set wins. Lease expiry makes the attempt stale, not successful or
failed; the scheduler classifies and retries it according to policy.

### Event envelope

Every event contains:

- protocol version
- event ID
- runner ID
- task ID
- attempt ID
- lease fence
- attempt-local sequence
- occurred-at and received-at timestamps
- typed payload

The API acknowledges only committed events. Duplicate event IDs return the
original acknowledgement. A sequence gap returns the expected next sequence;
the runner retries from its local durable spool.

## Persistence additions

- `runner_registrations`
- `runner_registration_tokens`
- `runner_tasks`
- `runner_task_attempts`
- `runner_task_events`
- `runner_task_cancellations`
- `artifacts`
- `artifact_links`
- `outbox_messages`

Secrets and raw bootstrap tokens are never stored. Log payloads may initially
use bounded event rows, but volume and retention measurements must be collected
before declaring PostgreSQL the long-term log store.

## Sandbox policy

The first executable adapter must enforce:

- digest-pinned OCI image
- new container per attempt
- non-root UID/GID
- read-only root filesystem
- disposable copy-on-write workspace
- no privileged mode or host namespaces
- no Docker socket
- all Linux capabilities dropped
- `no-new-privileges` and seccomp
- explicit PID, CPU, memory, disk, and wall-time limits
- disabled network by default
- no inherited host environment
- bounded termination grace period
- idempotent cleanup and orphan reconciliation

The source snapshot is copied into the disposable workspace. A user repository
is never mounted read-write from the host.

## Delivery slices

### Slice 2.0 — protocol replacement

- replace placeholder capabilities with closed schemas
- add task V2 and runner event V2 compatibility fixtures
- document V1 as non-executable and unsupported for claims
- add property tests for event sequence and terminal-state rules

Exit: contracts can represent every invariant without free-form capability
strings or filesystem paths.

Implementation status: Complete on 2026-07-31.

- V2 task and event schemas use closed capabilities, digest-pinned inputs,
  normalized command paths, explicit network policy, and bounded evidence.
- V1 task and event fixtures remain parseable but the runner port accepts V2
  only.
- Registration declares exact supported protocol tuples and structured
  capacity.
- Domain tests cover terminal immutability, cancellation races, replay, gaps,
  and safe sequence bounds.
- `audit:phase-2` preserves the execution-plane boundary and rejects model
  providers.

### Slice 2.1 — durable scheduler foundation

- add runner, task, attempt, and outbox migrations
- implement atomic claim and fenced heartbeat commands
- implement cancellation request and terminal compare-and-set
- add orphan and lease-expiry reconciliation
- publish task lifecycle events into the run timeline

Exit: concurrent PostgreSQL tests prove one active fence, stale-writer
rejection, idempotent claims, and crash recovery.

Implementation status: Complete on 2026-07-31.

Completed:

- workspace-scoped registration, task, attempt, and outbox schema
- composite tenant-chain foreign keys from task to experiment
- immutable task payload plus indexed scheduling projection
- experiment transition, task, and outbox atomic creation with rollback proof
- exact default-deny capability matching
- database-clocked atomic claim, capacity check, fence increment, and attempt
  creation
- fenced, unexpired heartbeat renewal
- real PostgreSQL concurrency proof that two claims yield one attempt
- idempotent replay of an unexpired acknowledged claim
- append-only cancellation identity with workspace-scoped, idempotent requests
- queued cancellation and leased/running cancellation-request projection
- fenced, lease-valid terminal compare-and-set with immutable terminal rows
- bounded `SKIP LOCKED` expired-attempt reconciliation
- retry-safe requeue with monotonically advancing subsequent claim fences
- non-retry-safe failure and cancellation-on-expiry classification
- transactional lifecycle outbox messages for accepted scheduler transitions
- real PostgreSQL cancellation-race, stale-writer, and expiry recovery proofs
- immutable V2 event envelopes tied to attempt/task/runner/fence identity
- normalized event-digest and attempt-sequence conflict detection
- concurrent exact replay acknowledgement after committed evidence
- gap, stale-fence, expired-lease, and invalid-evidence rejection
- task-snapshot validation for source, image, command order, and measurement
- lifecycle-driven attempt/task transitions with atomic terminal events
- transactional runner lifecycle projection into the run-event ledger
- explicit log/artifact deferral until bounded evidence storage is available
- transport-neutral runner application service
- exhaustive scheduler-result to `CommandError` mapping
- explicit attempt-ID conflict and sequence-gap application semantics
- exact replay preservation at the application boundary
- public runner transport withheld until deployment authentication

### Slice 2.2 — fake runner vertical slice

- register a deterministic in-process test adapter through the runner port
- claim a task, stream logs, record a measurement, and complete
- exercise cancellation, timeout, duplicates, gaps, and runner restart
- render execution status without making runner state a second source of truth

Exit: the complete control-plane journey passes without spawning a process.

Implementation status: Complete on 2026-07-31.

Current sub-slice:

- test-only deterministic adapter under the execution-plane package
- full claim-to-terminal PostgreSQL journey through scheduler ports
- explicit synthetic measurement fixture
- cancellation and restart/replay proofs without process execution

Completed:

- deterministic event IDs and explicit synthetic measurement fixtures
- full PostgreSQL claim-to-terminal lifecycle through public scheduler ports
- terminal restart replay without duplicate evidence
- out-of-order delivery rejection followed by ordered spool recovery
- durable cancellation observation and cancellation replay after restart
- no process, filesystem, network, container, browser, or model execution

### Slice 2.3 — artifact and log boundary

Status: Complete.

- implement content-addressed local artifact storage behind a port
- verify digest and size before metadata commit
- enforce chunk, task, and retention limits
- test redaction, HTML escaping, traversal, malformed media types, and quota
  exhaustion

Architecture decision: ADR-040.

Implementation order:

1. Add attempt-level accepted-byte counters and immutable artifact metadata.
2. Introduce the pathless artifact-store port and a local content-addressed
   adapter with streaming digest and size verification.
3. Add control-plane log redaction and verified-artifact admission before the
   scheduler transaction.
4. Admit both event kinds through the existing ordered acknowledgement
   boundary, with quota accounting in the same transaction.
5. Prove replay, quota, digest, traversal, inert rendering, and crash-boundary
   behavior against real PostgreSQL and a disposable filesystem root.

The slice does not add a public runner route, retention daemon, object-store
vendor, or executable runner.

Completed:

- content-addressed, pathless local artifact storage with exact digest and size
  verification
- immutable artifact object/provenance metadata and schema compatibility
  version `5`
- attempt-level log and artifact byte counters
- deterministic secondary log redaction and inert-text preservation
- quota-atomic ordered ingestion for log and artifact events
- exact replay, traversal, malformed media type, digest mismatch, and quota
  exhaustion proofs

Exit: untrusted outputs cannot escape their storage or rendering boundaries.

### Slice 2.4 — OCI engine spike

Status: Complete on 2026-07-31.

Architecture decision: ADR-041.

Detailed plan: `docs/plans/oci-engine-spike.md`.

- compare supported OCI backends against the sandbox policy
- record host-platform requirements and measured cold-start cost
- prove hard cancellation and orphan cleanup
- run adversarial mount, network, privilege, fork-bomb, disk-fill, and secret
  leakage tests
- produce one same-host comparison session that requires complete Docker and
  Podman evidence and at least one eligible candidate
- write the engine-selection ADR

Exit: a reviewed spike selects the backend. Spike code is not promoted by
default.

### Slice 2.5 — guarded local adapter

Status: Complete on 2026-07-31.

- implement the selected adapter without importing it into API or web
- require explicit runner bootstrap and `LOCAL_RUNNER_ENABLED=true`
- perform startup capability and policy self-checks
- reject execution when an enforcement primitive is unavailable
- add one real-container end-to-end experiment

Exit: one manually authored experiment produces a measurement and full
provenance inside a disposable sandbox.

The exit remains split across delivery slices: Slice 2.5 admitted the guarded
low-level OCI backend on the native reference host. Source materialization,
image/runtime admission, lifecycle events, and transport are explicit
prerequisites before a full experiment may execute.

### Slice 2.6 — source snapshot materializer

Status: Complete on 2026-07-31.

Architecture decision: ADR-043.

Detailed plan: `docs/plans/slice-2.6-source-snapshot-materializer.md`.

- add a pathless verified-artifact read capability
- parse uncompressed tar records without granting the parser filesystem access
- enforce bounded, portable paths and regular-file/directory-only archives
- publish private attempt-scoped source trees atomically
- return an opaque capability instead of a host path
- admit exactly one read-only source bind through the guarded OCI backend
- prove failure cleanup, exact-owner recovery, release, and native mount
  attestation

Exit: a verified snapshot can be materialized for one fenced attempt and
mounted read-only without any task or caller string becoming a host path.

### Slice 2.7 — admitted image catalog and task-runtime ABI

Status: Complete on 2026-07-31.

Architecture decision: ADR-044.

Detailed plan: `docs/plans/slice-2.7-image-catalog-runtime.md`.

- admit only preconfigured platform-specific image digests already present in
  rootless containerd
- inspect OCI manifest/config identity without pulling or trusting labels as
  authorization
- issue an opaque catalog-backed image capability
- define the `socrates.task-runtime.v1` bounded request-artifact and framed
  output protocols
- copy the admitted source into the bounded no-exec workspace
- invoke ordered commands with exact argv, cwd, timeout, and fixed environment
- frame binary child output and measurement bytes as untrusted data
- prove the catalog handshake and runtime protocol on the native reference host

Exit: one catalog-admitted image can consume a source capability and execute a
fixed ABI request without raw task commands becoming container-engine argv.

Native admission: GitHub Actions run `30641068455`; immutable evidence at
`services/runner-local/evidence/native/30641068455-runtime.json`.

### Slice 2.8 — runtime lifecycle event adapter

Status: Complete on 2026-07-31.

Architecture decision: ADR-045.

Detailed plan: `docs/plans/slice-2.8-runtime-lifecycle-adapter.md`.

- translate a closed runtime frame sequence into bounded V2 event drafts
- validate strict measurement JSON against the frozen task metric
- decode, redact, and chunk logs without duplicating measurement stdout
- map structured runtime failures to closed runner failure classifications
- keep event IDs, sequence, timestamps, persistence, and acknowledgement in the
  later durable-spool slice

Exit: successful and failed runtime results deterministically produce only
contract-valid, quota-bounded event drafts, with no production runner enabled.

Validation: all repository format, typecheck, lint, test, dependency-boundary,
build, and low-severity audit gates passed. Runner-local passed 124 tests; the
new lifecycle suites cover draft validation, Unicode-safe log handling, strict
measurement evidence, closed failure mapping, and terminal contradictions.

### Slice 2.9 — durable local event spool

Status: Complete on 2026-07-31.

Architecture decision: ADR-046.

Detailed plan: `docs/plans/slice-2.9-durable-event-spool.md`.

- bind each attempt spool to the canonical frozen execution identity
- allocate complete V2 envelopes only inside an atomically committed segment
- recover and replay pending events after the durable acknowledgement cursor
- validate exact acknowledgements before monotonically advancing the cursor
- fail closed on corruption, gaps, identity drift, capacity exhaustion, or
  concurrent mutation
- keep transport, task claiming, heartbeats, cancellation polling, and runner
  enablement outside the spool

Exit: restart and injected-crash tests prove that a closed lifecycle batch is
either absent or wholly durable, and that acknowledged evidence is never lost
or regenerated with different envelope identity.

Validation: GitHub Actions run `30644887440` passed the isolated database, API,
runner, browser, build, and native Linux spool gates. Immutable evidence is at
`services/runner-local/evidence/native/1785513485110-bbef45b2-ef4d-4bdd-a8cf-7358b8622bb4-spool.json`.

### Slice 2.10 — authenticated runner transport

Status: Complete on 2026-07-31.

Architecture decision: ADR-047.

Detailed plan: `docs/plans/slice-2.10-authenticated-runner-transport.md`.

- bind opaque, revocable bearer credentials to one runner/workspace principal
- expose exact claim, fenced heartbeat/cancel directive, and ordered event
  ingestion through strict bounded Hono routes
- add a typed single-attempt Node client and sequential durable-spool sender
- preserve task discovery, retry scheduling, coordinator loops, and OCI
  execution for later slices
- keep the production local-runner entry point disabled

Exit: authenticated transport tests prove that caller IDs cannot cross the
principal boundary and that ambiguous delivery never advances durable evidence.

Validation: GitHub Actions run `30647374933` passed schema compatibility 6,
real PostgreSQL credential/claim/heartbeat/cancellation/event replay, all
runner-local transport and spool tests, the browser journey, and production
builds. `LocalRunnerNotEnabledError` remains the production entry point.

### Slice 2.11 — durable work journal

Status: Complete on 2026-07-31.

Architecture decision: ADR-048.

Detailed plan: `docs/plans/slice-2.11-durable-work-journal.md`.

- commit delivery/task/attempt identity before the first claim request
- replay ambiguous claims with the exact durable attempt UUID
- persist the complete validated execution snapshot before handoff
- extract only execution-neutral private-filesystem durability primitives from
  the existing spool
- keep discovery, timers, heartbeat coordination, execution, and cleanup out of
  scope

Exit: injected crashes and restart tests prove that delivery creates at most
one visible attempt identity and a claim response is never handed off before
its immutable execution snapshot is durable.

Evidence: implementation commit `06612fa`; GitHub Actions run `30648879704`
passed native journal/spool durability, real PostgreSQL integration, browser,
and build gates and uploaded both native evidence artifacts. Runner-local
passed 178 local tests, including 19 work-journal tests.

### Slice 2.12 — fenced task offers

Status: Complete on 2026-07-31.

Architecture decision: ADR-049.

Detailed plan: `docs/plans/slice-2.12-fenced-task-offers.md`.

- reserve one compatible queued task to one authenticated runner;
- replay one immutable delivery ID before any local attempt is allocated;
- require that delivery ID when the durable journal attempt is claimed;
- keep the integration outbox semantically independent from runner discovery;
- keep polling timers, expiry/reassignment, execution, and cleanup out of
  scope.

Exit: PostgreSQL concurrency tests prove one active offer per task, runner
restart re-acquires the same offer, and no delivery becomes claimed without
the exact journal attempt and scheduler lease committing together.

Evidence: commits `c25f1f6` and `6193aab`; GitHub Actions run `30650673400`
passed schema compatibility 7, real PostgreSQL delivery concurrency, the
delivery-scoped authenticated transport journey, native durability probes,
browser tests, and production builds.

### Slice 2.13 — expired offer revocation

Status: Complete on 2026-07-31.

Architecture decision: ADR-050.

Detailed plan: `docs/plans/slice-2.13-expired-offer-revocation.md`.

- compute offer expiry from trusted server configuration and database time;
- revoke only expired, unclaimed offers in bounded locked batches;
- permit a new delivery only after the prior offer is durably revoked;
- prove claim-versus-revoke races cannot create a stale scheduler lease;
- keep timers, claimed-lease expiry, cleanup, and execution out of scope.

Exit: real PostgreSQL races prove claim or revocation wins one delivery row,
never both; a revoked delivery cannot claim, while a new delivery can safely
reserve the still-queued task.

Evidence: commits `9513f83` and `97e7d0f`; GitHub Actions run `30652305248`
passed schema compatibility 8, ordered expiry-index planning, real PostgreSQL
revocation/reassignment and concurrent bounded reconciliation, authenticated
API and runner integrations, native journal/spool durability, browser tests,
and production builds.

### Slice 2.14 — restart-first work admission

Status: Complete on 2026-07-31.

Architecture decision: ADR-051.

Detailed plan: `docs/plans/slice-2.14-restart-first-work-admission.md`.

- inspect durable local work before acquiring another delivery;
- replay claimed execution without network traffic;
- reconcile pending claims with the exact stored attempt identity;
- append an immutable rejection only for an authoritative claim conflict;
- keep timers, retries, lease supervision, execution, and cleanup out of
  scope.

Exit: crash-boundary tests prove each delivery has exactly one terminal local
claim outcome, stale offers stop retrying after durable rejection, and no new
offer is acquired while pending or claimed local work exists.

Evidence: implementation commit `13b0d4a`; GitHub Actions run `30653250463`
passed 194 runner-local tests, all database/API integrations, native v2 work
journal rejection durability, native spool durability, browser tests, and
production builds.

### Slice 2.15 — terminal acknowledgement completion

Status: Complete on 2026-07-31.

Architecture decision: ADR-052.

Detailed plan: `docs/plans/slice-2.15-terminal-ack-completion.md`.

- complete claimed work only from recovered terminal spool acknowledgement;
- append completion without deleting claim, spool, or journal history;
- keep incomplete evidence blocking new acquisition;
- let completed/rejected history coexist with later work;
- keep execution, heartbeat scheduling, cancellation, and cleanup out of
  scope.

Exit: fault and restart tests prove a claimed item becomes completed only
after exact terminal acknowledgement, and restart-first admission cannot
acquire early or remain blocked after durable completion.

Evidence: implementation commit `a48a61f`; GitHub Actions run `30654149358`
passed 204 runner-local tests, all database/API integrations, native spool and
v3 work-journal completion durability, browser tests, and production builds.

### Slice 2.16 — durable cancellation policy and one-step lease supervision

Status: Complete on 2026-07-31.

Architecture decision: ADR-053.

Detailed plan: `docs/plans/slice-2.16-lease-supervision.md`.

- persist immutable cancellation reason, grace period, and database timestamp;
- return a complete cancel command only from an exact-fence heartbeat;
- apply that command through a one-step runner cancellation port;
- surface stale authority separately from transient transport failure;
- keep clocks, timers, loops, execution, and terminal event generation out of
  scope.

Exit: migration, PostgreSQL, transport, and runner tests prove cancel policy is
stable across replay, cannot be runner-selected, and is applied only to the
exact execution identity returned by the durable claim.

Evidence: implementation commit `0e84b3b`; GitHub Actions run `30655485955`
passed schema compatibility 9 migration, all PostgreSQL/API/runner
integrations, native durability probes, Chromium, and production builds.

### Slice 2.17 — identity-bound sandbox cancellation scope

Status: Complete on 2026-07-31.

Architecture decision: ADR-054.

Detailed plan: `docs/plans/slice-2.17-sandbox-cancellation-scope.md`.

- bind one cancellation scope before execution preparation can begin;
- abort pre-start work and stop an active owned sandbox with server policy;
- deduplicate exact concurrent cancellation without retrying backend errors;
- reject identity or policy drift before any cancellation side effect;
- keep heartbeat timers, session loops, execution, events, and runner
  enablement out of scope.

Exit: deterministic race tests prove a cancel command cannot miss future
execution, target another fence, replace its first policy, or invoke backend
cancellation more than once.

Evidence: implementation commit `c35bf7b`; GitHub Actions run `30656584157`
passed 219 runner-local tests, all PostgreSQL/API/runner integrations, native
durability probes, Chromium, and production builds.

### Slice 2.18 — frozen execution plan projection

Status: Complete on 2026-07-31.

Architecture decision: ADR-055.

Detailed plan: `docs/plans/slice-2.18-execution-plan-projection.md`.

- validate one frozen execution against explicit trusted local limits;
- derive canonical runtime request and exact OCI resource profile once;
- account for every writable tmpfs inside the task aggregate budget;
- round CPU rate down to a declared cgroup quota quantum;
- reject unsupported, over-policy, or unrepresentable work without clamping;
- keep materialization, image admission, execution, supervision, events, and
  runner enablement out of scope.

Exit: pure adversarial tests prove every projected identity, command, metric,
and budget originates from the frozen execution and no hard limit is weakened
by derivation or rounding.

Evidence: implementation commit `0c3a925`; GitHub Actions run `30657580224`
passed 232 runner-local tests, all PostgreSQL/API/runner integrations, native
durability probes, Chromium, and production builds.

### Slice 2.19 — owned attempt preparation

Status: Complete on 2026-07-31.

Architecture decision: ADR-056.

Detailed plan: `docs/plans/slice-2.19-attempt-preparation.md`.

- bind one coordinator to one frozen claimed execution;
- project before I/O, then resolve the exact source artifact, admit the exact
  image, and materialize the exact source identity;
- share one preparation result/failure and one authoritative cancellation
  signal across duplicate callers;
- compensate every post-materialization failure and deduplicate explicit
  release without hiding cleanup uncertainty;
- keep runtime-request materialization, sandbox execution, global startup
  recovery, events, completion, and runner enablement out of scope.

Exit: adversarial tests prove no identity, image, source, cancellation, or
cleanup drift can escape the coordinator and restart reconstruction relies
only on durable execution identity, never serialized local capabilities.

Evidence: implementation commit `2645428`; GitHub Actions run `30658886159`
passed 248 runner-local tests, all PostgreSQL/API/runner integrations, native
durability probes, Chromium, and production builds.

### Slice 2.20 — startup owned-resource recovery barrier

Status: Complete on 2026-07-31.

Architecture decision: ADR-057.

Detailed plan: `docs/plans/slice-2.20-startup-recovery-barrier.md`.

- create one process-level barrier over fresh sandbox/source owners;
- remove exact-owned sandboxes before exact-owned source directories;
- share one immutable success or retained failure across concurrent callers;
- reject invalid cleanup results and provide no retry or degraded mode;
- keep durable-store opening, work admission, sessions, execution, events, and
  runner enablement out of scope.

Exit: ordering and failure-injection tests prove no source cleanup can race a
stale sandbox mount and no work-facing caller can interpret partial cleanup as
a successful startup gate.

Evidence: implementation commit `0b7d64e`; GitHub Actions run `30659524149`
passed 262 runner-local tests, all PostgreSQL/API/runner integrations, native
durability probes, Chromium, and production builds.

### Slice 2.21 — bounded source artifact resolution

Status: Complete on 2026-07-31.

Architecture decision: ADR-058.

Detailed plan: `docs/plans/slice-2.21-source-artifact-resolution.md`.

- bind one resolver to one exact lease identity and archive-size policy;
- request the exact snapshotId/digest through a narrow authenticated transport;
- validate declared media type/length before streaming;
- write through the content-addressed store with independent size/digest
  verification and attempt cancellation;
- retain one result/failure and reject authority drift before transport I/O;
- keep HTTP routes, object-store serving, task schema changes,
  materialization, sessions, and runner enablement out of scope.

Exit: adversarial streaming tests prove forged descriptors, truncation,
overflow, digest drift, cancellation, duplicate calls, and identity drift
cannot produce a verified artifact capability.

Evidence: implementation commit `3033a0b`; GitHub Actions run `30660344955`
passed 290 runner-local tests, all PostgreSQL/API/runner integrations, native
durability probes, Chromium, and production builds.

### Slice 2.22 — authenticated fenced source transport

Status: Complete on 2026-07-31.

Architecture decision: ADR-059.

Detailed plan: `docs/plans/slice-2.22-authenticated-source-transport.md`.

- add immutable source snapshot metadata with a forward-only migration;
- authorize exact source reads against the current unexpired fenced lease;
- verify catalog metadata through the configured artifact store;
- stream bytes from an authenticated bounded API route without redirects;
- implement the runner transport as a non-buffering async iterable;
- keep source ingestion, signed URLs, extraction, sessions, and runner
  enablement out of scope.

Exit: PostgreSQL/API/client integration tests prove credentials alone cannot
read bytes and stale, drifted, missing, oversized, truncated, or mutated
sources cannot become resolver authority.

Evidence: implementation commit `94e1a25`, integration-fixture correction
`1fd11b8`; GitHub Actions run `30662277227` passed schema-version-10 migration,
all PostgreSQL/API/runner integrations, 295 runner-local tests, native
durability probes, Chromium, and production builds.

### Slice 2.23 — durable execution-start barrier

Status: Complete on 2026-07-31.

Architecture decision: ADR-060.

Detailed plan: `docs/plans/slice-2.23-durable-execution-start.md`.

- publish one immutable, checksummed execution-start record before sandbox
  creation can be authorized;
- bind it to the durable claim digest and exact attempt key;
- replay only byte-equivalent identity and reject invalid transition order;
- surface unresolved started work as indeterminate before new acquisition;
- preserve pre-start cancellation completion without inventing execution;
- keep lease reconciliation, session scheduling, sandbox execution, evidence
  generation, and runner enablement out of scope.

Exit: durability fault injection and recovery tests prove a crash on either
side of the start barrier can never make an already-started attempt executable
again.

Evidence: implementation commit `cb9bae3`, cross-platform fixture correction
`1a652ec`; GitHub Actions run `30663648242` passed 306 runner-local tests, all
PostgreSQL/API/runner integrations, the Linux native work-journal v4 probe,
Chromium, and production builds.

### Slice 2.24 — indeterminate attempt reconciliation

Status: Complete on 2026-07-31.

Architecture decision: ADR-061.

Detailed plan: `docs/plans/slice-2.24-indeterminate-reconciliation.md`.

- reconcile only the authenticated exact runner/task/attempt/fence identity;
- serialize against heartbeat and completion by locking task and attempt;
- keep an unexpired attempt current without renewing it;
- apply existing expiry, retry-safety, cancellation, and outbox semantics when
  the exact lease has expired;
- durably retire the local started item before later acquisition can proceed;
- keep polling, execution, invented terminal evidence, cleanup, and runner
  enablement out of scope.

Exit: PostgreSQL race tests and local fault injection prove that a started
attempt is never replayed and is skipped only after an irreversible server
retirement has been durably recorded.

Evidence: implementation commit `5497fd7`, isolated PostgreSQL fixture
correction `5c28746`; GitHub Actions run `30665390494` passed exact
reconciliation/heartbeat races, authenticated API and runner integrations,
Linux native work-journal v5, Chromium, and production builds.

### Slice 2.25 — closed local failure evidence policy

Status: Complete on 2026-07-31.

Architecture decision: ADR-062.

Detailed plan: `docs/plans/slice-2.25-local-failure-evidence.md`.

- define a closed runner-owned failure-code taxonomy;
- map each code to fixed redacted terminal evidence;
- require authenticated cancellation authority for cancellation drafts;
- keep runtime-reported outcomes on the existing lifecycle adapter path;
- prohibit transport, spool, acknowledgement, and journal ambiguity from
  inventing terminal results;
- keep session composition, execution, persistence, and runner enablement out
  of scope.

Exit: exhaustive table tests prove every supported local failure produces one
stable valid draft and every ambiguous post-evidence failure produces none.

Evidence: implementation commit `2527aad`; 28 focused policy tests and 343
runner-local tests passed locally with all repository quality gates. GitHub
Actions run `30666098009` passed every integration suite, both Linux native
durability probes, Chromium, and production builds.

### Slice 2.26 — fail-stop lease authority monitor

Status: Complete on 2026-07-31.

Architecture decision: ADR-063.

Detailed plan: `docs/plans/slice-2.26-lease-authority-monitor.md`.

- send an exact first heartbeat immediately, then use one non-overlapping
  deterministic cadence;
- treat only authenticated renewal as current authority and never compare
  local wall time with lease timestamps;
- revoke local attempt work on stale or uncertain authority without inventing
  terminal evidence;
- preserve authenticated cancellation as a separate server-authorized path;
- make explicit owner stop wait for an in-flight heartbeat outcome;
- keep acquisition, attempt-session composition, execution, events,
  persistence, and runner enablement out of scope.

Exit: deterministic timer and race tests prove heartbeat calls cannot overlap,
normal stop cannot discard a response, and every stale or uncertain outcome
fails local execution closed without producing lifecycle evidence.

Evidence: implementation commit `c400b14`; 16 focused monitor tests and 364
runner-local tests passed locally with every repository quality gate. GitHub
Actions run `30666995698` passed every integration suite, both Linux native
durability probes, Chromium, and production builds.

### Slice 2.27 — mandatory runtime start barrier

Status: Complete on 2026-07-31.

Architecture decision: ADR-064.

Detailed plan: `docs/plans/slice-2.27-runtime-start-barrier.md`.

- require an explicit start-barrier capability for every runtime execution;
- materialize the request and check cancellation before crossing it;
- invoke the sandbox backend immediately after successful durable crossing;
- release the request capability on all post-materialization paths;
- bind delivery and execution identity in one replay-stable journal adapter;
- keep admission, lease monitoring, events, completion, session composition,
  and runner enablement out of scope.

Exit: call-order, fault-injection, cancellation, cleanup, and replay tests prove
that no sandbox invocation can occur before a durable exact execution-start
record and no pre-barrier failure can become indeterminate unnecessarily.

Evidence: cleanup-policy documentation commit `1aaf429` and implementation
commit `2537dff`; eight barrier tests, the 15-test executor suite, and 379
runner-local tests passed locally with every repository quality gate. GitHub
Actions run `30667861578` passed every integration suite, both Linux native
durability probes, Chromium, and production builds.

### Slice 2.28 — terminal evidence recovery before retirement

Status: Complete on 2026-07-31.

Architecture decision: ADR-065.

Detailed plan: `docs/plans/slice-2.28-terminal-evidence-recovery.md`.

- inspect exact existing spool state without creating manifests;
- drain a terminal batch by its frozen initial pending count;
- complete local work only after exact durable terminal acknowledgement;
- recover evidence before execution-started lease reconciliation;
- suppress reconciliation and acquisition on ambiguity or same-call
  completion;
- keep claimed pre-start evidence, execution, event creation, polling, and
  runner enablement out of scope.

Exit: restart, transport ambiguity, acknowledgement, completion, and admission
ordering tests prove durable terminal evidence is replayed before retirement
and cannot be skipped or replaced by a new attempt.

Evidence: implementation commit `c7f5f11`; 16 focused recovery tests and 398
runner-local tests passed locally with every repository quality gate. A real
filesystem restart replayed only the remaining event from a partially
acknowledged terminal batch and committed durable work completion. GitHub
Actions run `30668714816` passed every integration suite, both Linux native
durability probes, Chromium, and production builds.

### Slice 2.29 — pre-start terminal evidence recovery

Status: Complete on 2026-07-31.

Architecture decision: ADR-066.

Detailed plan: `docs/plans/slice-2.29-pre-start-evidence-recovery.md`.

- recover exact terminal evidence for claimed work before returning ready;
- reuse the single ADR-065 bounded replay and completion path;
- carry durable delivery identity in every ready admission result;
- suppress execution and acquisition on recovery ambiguity;
- keep execution, fresh event creation, polling, and runner enablement out of
  scope.

Exit: restart and ambiguity tests prove a claimed attempt with terminal
evidence completes before it can be released for execution.

Evidence: implementation commit `0fa3686`; focused claimed-recovery tests and
400 runner-local tests passed locally with every repository quality gate.
GitHub Actions run `30669383760` passed every integration suite, both Linux
native durability probes, Chromium, and production builds.

### Slice 2.30 — terminal evidence publication

Status: Complete on 2026-08-01.

Architecture decision: ADR-067.

Detailed plan: `docs/plans/slice-2.30-terminal-evidence-publication.md`.

- validate delivery ownership and terminal batch shape before side effects;
- recover existing exact evidence before any fresh append;
- append one lifecycle batch and reuse ADR-065 for delivery and completion;
- preserve byte-stable recovery across every ambiguity boundary;
- serialize duplicate calls into one append and durable completion;
- keep execution, session composition, polling, and runner enablement out of
  scope.

Exit: mutation, fault-boundary, restart, identity, and concurrency tests prove
fresh terminal evidence cannot allocate duplicate event identities on retry.

Evidence: implementation commit `86d7e01`; 18 focused publication tests and
425 runner-local tests passed locally with every repository quality gate. A
real durable-store restart recovered completed evidence without a new event
identity, clock read, or network send. GitHub Actions run `30706571197` passed
every integration suite, both Linux native durability probes, Chromium, and
production builds.

### Slice 2.31 — cancellation termination receipt

Status: Complete on 2026-08-01.

Architecture decision: ADR-068.

Detailed plan: `docs/plans/slice-2.31-cancellation-termination-receipt.md`.

- replace the ambiguous cancellation boolean with an authoritative receipt;
- distinguish absent, graceful, and forced termination without inference;
- skip unconditional kill after successful graceful stop;
- propagate the exact receipt through scope, supervisor, and monitor;
- fail closed on stop, kill, or cleanup uncertainty;
- keep session composition, outcome arbitration, polling, and runner
  enablement out of scope.

Exit: deterministic and native tests prove forced cancellation evidence can be
derived only from an authoritative successful escalation receipt.

Evidence: implementation commit `c7d5669`; 57 focused receipt tests and 436
runner-local tests passed locally with every repository quality gate. GitHub
Actions run `30707452237` passed every integration suite, both Linux native
durability probes, Chromium, and production builds. OCI reference-host run
`30707705105` passed guarded backend and admitted runtime validation; schema
versions 3 and 6 both recorded exact forced-termination receipts with cleanup.

### Slice 2.32 — terminal outcome arbitration policy

Status: Complete on 2026-08-01.

Architecture decision: ADR-069.

Detailed plan: `docs/plans/slice-2.32-terminal-outcome-arbitration.md`.

- define closed terminal candidate, execution-start, and authority facts;
- apply one authority-first precedence table without promise or clock order;
- let a terminated cancellation receipt override local candidates;
- preserve complete runtime evidence when cancellation observes no sandbox;
- return closed `no_evidence` decisions for stale, uncertain, or contradictory
  observations;
- keep session composition, side effects, polling, and runner enablement out of
  scope.

Exit: exhaustive table and mutation tests prove every supported race has one
deterministic frozen decision and no ambiguous authority state can create
terminal evidence.

Evidence: implementation commit `ce9b2e9`; 37 focused arbiter tests and 473
runner-local tests passed locally with every repository quality gate. The
receipt validator now lives in a pure contract module outside the backend
adapter. GitHub Actions run `30708344642` passed every integration suite, both
Linux native durability probes, Chromium, and production builds.

### Slice 2.33 — publication authority checkpoint

Status: Complete on 2026-08-01.

Architecture decision: ADR-070.

Detailed plan: `docs/plans/slice-2.33-publication-authority-checkpoint.md`.

- serialize an explicit checkpoint with the monitor heartbeat cadence;
- join the in-flight heartbeat or wake one scheduled wait without overlap;
- return only renewed, authenticated cancellation, or stale checkpoint facts;
- settle concurrent checkpoint callers through one frozen observation;
- replace the arbiter's pre-publication stopped branch with renewed;
- reserve monitor stop for post-acknowledgement durable completion;
- keep publication, session composition, polling, and runner enablement out of
  scope.

Exit: cadence and arbiter tests prove publication eligibility can be observed
without local clock inference, overlapping heartbeats, or premature monitor
stop.

Evidence: implementation commit `9636848`; 26 focused monitor tests, 39
focused arbiter tests, and 485 runner-local tests passed locally with every
repository quality gate and the low-severity dependency audit. GitHub Actions
run `30709048533` passed every database, API, runner, native durability,
Chromium, and production-build gate. Publication and session composition remain
disabled.

### Slice 2.34 — closed local attempt observation

Status: Complete on 2026-08-01.

Architecture decision: ADR-071.

Detailed plan: `docs/plans/slice-2.34-local-attempt-observation.md`.

- normalize every local execution stage into the closed failure policy;
- distinguish explicit authority abort from unrelated concurrent failure;
- record elapsed duration only after the durable execution-start barrier;
- prepare, execute, adapt, and release through one single-flight observer;
- return only frozen timing and candidate inputs for ADR-069;
- prove cleanup failure overrides otherwise publishable local evidence;
- keep authority, publication, polling, and runner enablement out of scope.

Exit: adversarial stage, cancellation, timing, cleanup, and re-entry tests prove
one local attempt closes into one immutable arbitration observation without
publishing an event or owning lease authority.

Evidence: implementation commit `f750aa1`; 13 observer, 11 durable-timing, 16
preparation, 19 runtime-executor, and 23 OCI-backend tests passed with all 516
runner-local tests and every local repository gate. Main CI run `30710103241`
passed all database, API, runner, native durability, Chromium, and build gates.
OCI reference-host run `30710335532` independently proved forced exact-fence
termination, complete cleanup, source release, guarded backend execution, and
the admitted runtime on real rootless infrastructure.

### Slice 2.35 — durable publication disposition

Status: Complete on 2026-08-01.

Architecture decision: ADR-072.

Detailed plan: `docs/plans/slice-2.35-publication-disposition.md`.

- audit exact journal and spool state after each publication dependency failure;
- distinguish absent, pending, acknowledged, and completed durable outcomes;
- return recovered success when durable completion outruns a lost response;
- reject impossible or unauditable combinations without guessing;
- preserve causes only in memory behind redacted boundary errors;
- prove failure auditing performs no append, send, acknowledgement, or complete;
- keep retries, abandonment, session composition, polling, and enablement out of
  scope.

Exit: failure-injection and mutation tests prove every publication boundary
either reports its exact durable disposition, recovers completed success, or
fails closed without changing durable state.

Evidence: implementation commit `2066567`; 22 disposition-auditor and 24
publication-coordinator tests passed with all 544 runner-local tests and every
local repository gate. Main CI run `30711001656` passed all PostgreSQL, API,
runner, native durability, Chromium product-journey, production-build, and
evidence-upload gates. ADR-072 is admitted; publication retry and monitor
ownership remain deliberately unresolved for the next architecture slice.

### Slice 2.36 — explicit lease-authority release

Status: Complete on 2026-08-01.

Architecture decision: ADR-073.

Detailed plan: `docs/plans/slice-2.36-lease-authority-release.md`.

- distinguish clean completion release from terminal-publication abandonment;
- make the first owner release intent single-flight and immutable;
- preserve cancellation, stale, and uncertainty precedence over owner release;
- map publication success, disposition, and fatal failure through a pure
  authority policy;
- prove release never starts another heartbeat or invokes sandbox revocation;
- keep retry, reconciliation, session composition, polling, and enablement out
  of scope.

Exit: adversarial monitor and policy tests prove every publication state has
one exact retain/stop/abandon decision and abandonment cannot be observed as
clean completion.

Evidence: implementation commit `59341f8`; 34 lease-authority-monitor and 21
publication-authority-policy tests passed with all 573 runner-local tests and
every local repository gate. Main CI run `30711742434` passed all PostgreSQL,
API, runner, native durability, Chromium product-journey, production-build, and
evidence-upload gates. ADR-073 is admitted; retry/recovery ownership remains a
separate prerequisite before session composition.

### Slice 2.37 — bounded terminal publication ownership

Status: Complete on 2026-08-01.

Architecture decision: ADR-074.

Detailed plan: `docs/plans/slice-2.37-terminal-publication-owner.md`.

- bind one publication operation to one single-flight owner;
- retry acknowledged evidence locally without an authority heartbeat;
- require a fresh checkpoint before every pending-evidence retry;
- bound retries explicitly and abandon on fatal failure or exhaustion;
- preserve completed publication across clean-stop cancellation/stale races;
- keep restart reconciliation, session composition, polling, and enablement out
  of scope.

Exit: adversarial ownership tests prove no deferred publication can retry
without the exact required authority action or release through the wrong
terminal monitor path.

Evidence: implementation commit `57a7bb9`; 45 publication-owner tests and 100
combined owner/policy/monitor tests passed with all 618 runner-local tests and
every local repository gate. Main CI run `30712598503` passed all PostgreSQL,
API, runner, native durability, Chromium product-journey, production-build, and
evidence-upload gates. ADR-074 is admitted; restart reconciliation remains the
last known ordering prerequisite before attempt-session composition.

### Slice 2.38 — restart terminal-evidence triage

Status: Complete on 2026-08-01.

Architecture decision: ADR-075.

Detailed plan: `docs/plans/slice-2.38-restart-evidence-triage.md`.

- audit terminal disposition before restart-side recovery or reconciliation;
- complete acknowledged evidence locally without lease reconciliation;
- reconcile pending evidence before allowing any replay;
- reconcile recovered claimed work before returning it as executable;
- expose current pending evidence as a frozen recovery-pending handoff;
- keep monitor/session wiring, polling, and enablement out of scope.

Exit: state/order tests prove a restarted process cannot send pending evidence
or execute a recovered claim before exact reconciliation, while fully
acknowledged evidence still completes without a network authority dependency.

Evidence: implementation commit `f69c2af`; 41 restart-triage tests passed with
all 659 runner-local tests and every locally applicable repository gate. Main
CI run `30713739060` passed all PostgreSQL, API, runner, native durability,
Chromium product-journey, production-build, and evidence-upload gates. ADR-075
is admitted; attempt-session composition, monitor startup, polling, and runner
enablement remain separate decisions.

### Slice 2.39 — recovery-only terminal publication

Status: Complete on 2026-08-01.

Architecture decision: ADR-076.

Detailed plan: `docs/plans/slice-2.39-recovery-only-publication.md`.

- bind exact restart delivery/execution without accepting terminal drafts;
- expose no spool append capability at the recovery publication boundary;
- convert completed audit evidence into recovered success;
- preserve pending/acknowledged disposition for ADR-074 bounded ownership;
- fail closed on absent, inconsistent, drifting, or uncertain evidence;
- keep monitor/session wiring, polling, and enablement out of scope.

Exit: type boundaries and real durable restart tests prove a
`recovery_pending` handoff can drain only its existing terminal spool and can
never manufacture a new event batch if that evidence is absent or uncertain.

Evidence: implementation commit `9559f45`; 37 recovery-only publication tests
passed with all 696 runner-local tests and every local repository gate. Main CI
run `30715071832` passed all PostgreSQL, API, runner, Linux native durability,
Chromium product-journey, production-build, and evidence-upload gates. ADR-076
is admitted; monitor construction, attempt-session composition, polling, and
runner enablement remain separate decisions.

### Slice 2.40 — restart terminal recovery session

Status: Complete on 2026-08-01.

Architecture decision: ADR-077.

Detailed plan: `docs/plans/slice-2.40-restart-terminal-recovery-session.md`.

- accept only an exact ADR-075 `recovery_pending` handoff;
- construct one identity-bound cancellation scope, supervisor, authority
  monitor, recovery-only publication, and bounded publication owner;
- start and observe authority before recovery publication begins;
- settle owner and monitor together without Promise-race policy;
- prove every success and failure path leaves no owned heartbeat behind;
- keep fresh execution, outcome arbitration, polling, and enablement out of
  scope.

Exit: adversarial ordering and integration tests prove a restart handoff can
settle existing evidence under one exact lease owner, while malformed identity,
terminal authority, and publication failure cannot orphan supervision or gain
append authority.

Evidence: implementation commit `a49fb60`; 31 restart recovery session tests
passed with all 727 runner-local tests and every local repository gate. Main CI
run `30716554709` passed all PostgreSQL, API, runner, Linux native durability,
Chromium product-journey, production-build, and evidence-upload gates. ADR-077
is admitted; fresh attempt execution, startup orchestration, polling, and runner
enablement remain separate decisions.

### Slice 2.41 — no-evidence authority release

Status: Complete on 2026-08-01.

Architecture decision: ADR-078.

Detailed plan: `docs/plans/slice-2.41-no-evidence-authority-release.md`.

- distinguish missing terminal evidence from completion and publication
  abandonment;
- abort only a scheduled wait and send no heartbeat for release;
- let an in-flight cancellation, stale result, or uncertainty outrank release;
- leave active journal work untouched for authoritative restart triage;
- reject checkpoints and publication-owner release conflicts after release;
- keep arbitration, fresh sessions, polling, and enablement out of scope.

Exit: monitor and owner-policy tests prove an evidence-free attempt can release
heartbeat ownership without claiming completion, publication failure, server
retirement, or a locally inferred lease outcome.

Evidence: implementation commit `f716f67`; 15 focused authority-release and
publication-owner tests passed with all 744 runner-local tests and every local
repository gate applicable on Windows. Main CI run `30717770398` passed all
PostgreSQL, API, runner, Linux native durability, Chromium product-journey,
production-build, and evidence-upload gates. ADR-078 is admitted; outcome
arbitration, fresh attempt-session composition, polling, and runner enablement
remain separate decisions.

### Slice 2.42 — closed local timing uncertainty

Status: Complete on 2026-08-01.

Architecture decision: ADR-079.

Detailed plan: `docs/plans/slice-2.42-closed-local-timing-uncertainty.md`.

- resolve exact monotonic timing uncertainty as one redacted timing fact;
- preserve cleanup settlement before the observer returns that fact;
- make the pure arbiter return `observation_uncertain` without an event;
- retain authority-first precedence and exact cancellation identity checks;
- reject malformed or disguised uncertainty and preserve normal timing paths;
- keep authority wiring, publication, fresh sessions, polling, and enablement
  out of scope.

Exit: observer and arbiter tests prove every exact timing-uncertain attempt can
reach one immutable no-evidence decision without inventing duration, failure,
cancellation, or authority meaning.

Evidence: implementation commit `f521a45`; 15 focused observer and arbiter
tests passed with all 759 runner-local tests and every local repository gate
applicable on Windows. Main CI run `30718820150` passed all PostgreSQL, API,
runner, Linux native durability, Chromium product-journey, production-build,
and evidence-upload gates. ADR-079 is admitted; authority/session composition,
publication wiring, polling, and runner enablement remain separate decisions.

### Slice 2.43 — fresh attempt session ownership

Status: Complete on 2026-08-01.

Architecture decision: ADR-080.

Detailed plan: `docs/plans/slice-2.43-fresh-attempt-session-ownership.md`.

- accept only an exact fresh or safely reconciled ADR-075 `ready` handoff;
- construct one identity-bound authority, execution, arbitration, and
  publication composition from narrow capabilities;
- start authority before any local execution effect and checkpoint only after
  local cleanup settlement;
- publish only exact evidence decisions and release only exact no-evidence
  decisions;
- await and compare publication/no-evidence ownership with monitor settlement;
- keep startup, acquisition, polling, concurrency, and enablement out of scope.

Exit: adversarial ordering and durable-store tests prove every supported
one-attempt result closes local capabilities, authority, and publication under
one owner without promise-race policy or detached supervision.

Evidence: implementation commit `95d11c3`; 23 focused fresh-session tests
passed with all 782 runner-local tests and every local repository gate against
fresh PostgreSQL database `socrates_ci_adr080`. Main CI run `30720392087`
passed all PostgreSQL, API, runner, Linux native durability, Chromium
product-journey, production-build, and evidence-upload gates. ADR-080 is
admitted; startup ownership, acquisition, polling, concurrency scheduling, and
runner enablement remain separate decisions.

### Slice 2.44 — startup-gated attempt dispatch

Status: Completed on 2026-08-01.

Architecture decision: ADR-081.

Detailed plan: `docs/plans/slice-2.44-startup-gated-attempt-dispatch.md`.

- defer all admission/session composition until ADR-057 succeeds;
- serialize each explicit admission through complete session settlement;
- route `ready` only to ADR-080 and `recovery_pending` only to ADR-077;
- return non-session admission states without constructing a session;
- retain the first failed startup, composition, admission, or session boundary
  and prohibit in-process retry;
- keep concrete process startup, timers, polling, backoff, concurrency, and
  runner enablement out of scope.

Exit: adversarial routing and ordering tests prove no admission can precede
startup cleanup, no second attempt can overlap the first, and no failed process
boundary can retry or detach attempt ownership.

Admission: implementation commit `f805358`; 42 focused dispatcher tests and
all 824 runner-local tests passed against fresh migrated PostgreSQL database
`socrates_ci_adr081`. Main CI run `30721734779` passed every required Linux,
PostgreSQL, API, runner, native durability, Chromium journey, production-build,
and evidence-upload gate. ADR-081 is admitted. Concrete process composition,
polling, concurrency scheduling, and runner enablement remain deferred.

### Slice 2.45 — recovery-bound local attempt composition

Status: Completed on 2026-08-01.

Architecture decision: ADR-082.

Detailed plan: `docs/plans/slice-2.45-recovery-bound-attempt-composition.md`.

- introduce one effect-free `LocalAttemptOwner` as the concrete explicit-
  dispatch assembly boundary;
- bind the exact sandbox/source owners to both ADR-057 recovery and every
  later session capability;
- open one non-overlapping journal/spool pair only after startup succeeds;
- share one sender, completion, recovery, disposition, and admission graph;
- capture narrow dependency methods and freeze bounded configuration before
  any dispatch effect;
- preserve ADR-081 serialization and fail-stop behavior without adding a
  process root, timer, polling loop, backoff, or runner enablement.

Exit: real-store and adversarial composition tests prove recovery precedes
store opening, recovered owners cannot be swapped, all attempt paths share one
durable graph, partial composition cannot retry, and construction is inert.

Admission: implementation commit `6046a23`; 20 focused owner tests and all 844
runner-local tests passed against fresh migrated PostgreSQL database
`socrates_ci_adr082b`. Main CI run `30722897508` passed every required Linux,
PostgreSQL, API, runner, native durability, Chromium journey, production-build,
and evidence-upload gate. ADR-082 is admitted. Node timing adapters, repeated
dispatch lifecycle, process configuration, and runner enablement remain
deferred.

### Slice 2.46 — Node attempt timing adapters

Status: Completed on 2026-08-02.

Architecture decision: ADR-083.

Detailed plan: `docs/plans/slice-2.46-node-attempt-timing-adapters.md`.

- implement one bounded, referenced Node authority scheduler;
- preserve exact `AbortSignal.reason` identity for ADR-026 checkpoint and
  owner-release sentinels;
- make expiry/abort races single-settlement with complete listener/timer
  cleanup and inert late callbacks;
- add a frozen on-demand `performance.now()` monotonic source;
- keep both capabilities explicit in `LocalAttemptOwner` composition;
- exclude work polling, idle waits, retry/backoff, process startup, shutdown,
  and runner enablement.

Exit: fake-timer and real-clock tests prove exact abort identity, bounded Node
delay semantics, no detached callback/listener effects, monotonic source
behavior, fixed errors, and successful integration with the admitted lease
monitor and timing barrier.

Admission: implementation commit `1d96858`; 35 focused timing-adapter tests
and all 879 runner-local tests passed against fresh migrated PostgreSQL
database `socrates_ci_adr083`. Main CI run `30723737177` passed every required
Linux, PostgreSQL, API, runner, native durability, Chromium journey,
production-build, and evidence-upload gate. ADR-083 is admitted. Repeated
dispatch lifecycle, process configuration, shutdown ownership, and runner
enablement remain deferred.

### Slice 2.47 — observed fail-stop local dispatch lifecycle

Status: Completed on 2026-08-02.

Architecture decision: ADR-084.

Detailed plan: `docs/plans/slice-2.47-local-attempt-dispatch-loop.md`.

- repeat only the admitted `LocalAttemptOwner.dispatchNext()` boundary;
- serialize dispatch, result validation, and observation with no overlap;
- delay only `idle` and server-authoritative `indeterminate` results by one
  fixed bounded interval;
- preserve exact abort identity as cooperative shutdown without replacing
  authenticated attempt cancellation authority;
- fail-stop on every other dispatch, observer, delay, or result-shape failure;
- keep environment loading, process startup, OS signals, shutdown timeout,
  adaptive backoff, concurrency, and runner enablement out of scope.

Exit: adversarial lifecycle tests prove no attempt overlap or busy idle loop,
every result is observed before advancement, indeterminate work is never
retired from local time, shutdown waits for owned settlement, and uncertainty
cannot retry or detach work.

Admission: implementation commit `c7b1ec6`; 43 focused lifecycle and
real-owner integration tests and all 922 runner-local tests passed against
fresh migrated PostgreSQL database `socrates_ci_adr084`. Main CI run
`30724666887` passed every required Linux, PostgreSQL, API, runner, native
durability, Chromium journey, production-build, and evidence-upload gate.
ADR-084 is admitted. Process configuration, concrete observation, shutdown
ownership, resource composition, and runner enablement remain deferred.

### Slice 2.48 — attempt-scoped source resolver factory

Status: Admitted on 2026-08-02.

Architecture decision: ADR-085.

Detailed plan: `docs/plans/slice-2.48-attempt-scoped-source-resolver.md`.

- replace the process-shared resolver instance with one captured factory;
- derive resolver identity only from the coordinator's parsed execution;
- create and validate one exact resolver after preparation begins;
- expose and snapshot exact resolver identity before source transport;
- fail closed on malformed, identity-drifted, throwing, or reused resolvers;
- add a concrete factory that captures transport/store methods and creates a
  distinct ADR-058 resolver for every attempt;
- keep process/resource configuration and runner enablement out of scope.

Exit: adversarial and real resolver tests prove sequential attempts cannot
share source authority, identity cannot be substituted, constructor inertness
is preserved, and dependency mutation cannot redirect source bytes.

Admission: implementation commit `91629b4`; 22 new adversarial tests and all
944 runner-local tests passed against fresh migrated PostgreSQL database
`socrates_ci_adr085`. Main CI run `30725526404` passed every required Linux,
PostgreSQL, API, runner, native durability, Chromium journey,
production-build, and evidence-upload gate. ADR-085 is admitted. Environment
loading, process resource composition, shutdown ownership, and runner
enablement remain deferred.

### Slice 2.49 — strict local runner configuration snapshot

Status: Admitted on 2026-08-02.

Architecture decision: ADR-086.

Detailed plan: `docs/plans/slice-2.49-local-runner-configuration.md`.

- define one strict versioned non-secret configuration contract;
- make shared identities, roots, byte bounds, and cadence single-authority;
- validate origin, canonical private roots, integer bounds, and cross-field
  relationships before any resource effect;
- rebuild and deeply freeze the exact accepted data graph;
- reject secrets, environment maps, functions, unknown keys, aliases, and
  duplicated authority;
- keep environment/credential loading, resources, shutdown, and runner
  enablement out of scope.

Exit: adversarial parser tests prove malformed or conflicting configuration
fails before effects, accepted configuration is exact and immutable, shared
resource values cannot drift, and no secret or process authority enters the
snapshot.

Admission: implementation commit `0f3270e`; 75 focused adversarial and
property-based parser tests and all 1019 runner-local tests passed against fresh
migrated PostgreSQL database `socrates_ci_adr086`. Main CI run `30726331992`
passed every required Linux, PostgreSQL, API, runner, native durability,
Chromium journey, production-build, and evidence-upload gate. ADR-086 is
admitted. Environment and credential loading, resource composition, shutdown
ownership, and runner enablement remain deferred.

### Slice 2.50 — inert attempt lifecycle composition

Status: Admitted on 2026-08-02.

Architecture decision: ADR-087.

Detailed plan: `docs/plans/slice-2.50-attempt-lifecycle-composition.md`.

- admit configuration before touching any external capability;
- align outer configuration bounds with every admitted constructor before
  composing the graph;
- compose artifact, source, resolver, request, owner, and dispatch resources
  from the single configuration snapshot;
- inject already-authorized control-plane, sandbox, image, timing, identity,
  durability, and observation capabilities;
- expose only one retained `run(signal)` lifecycle;
- prove inert construction, exact field mapping, method capture, real durable
  startup, and fail-stop ownership;
- keep platform transport/OCI/image construction, secrets, environment,
  process startup, shutdown, and enablement out of scope.

Exit: real and adversarial tests prove configuration precedes dependency
access, construction has no effects, every composed authority comes from one
snapshot or explicit capability, and the first run owns the existing durable
attempt lifecycle without exposing internal resources.

Admission: implementation commit `898e67f`; 36 focused lifecycle tests, 77
strict parser tests, and all 1,057 runner-local tests passed against fresh
migrated PostgreSQL database `socrates_ci_adr087_retry`. Main CI run
`30727600459` passed every required Linux, PostgreSQL, API, runner, native
durability, Chromium journey, production-build, and evidence-upload gate.
ADR-087 is admitted. Platform resource composition, credentials, environment
loading, process startup, shutdown ownership, and enablement remain deferred.

### Slice 2.51 — authenticated control-plane composition

Status: Admitted on 2026-08-02.

Architecture decision: ADR-088.

Detailed plan: `docs/plans/slice-2.51-authenticated-control-plane-composition.md`.

- parse ADR-086 before reading a secret or external capability;
- validate one separately injected bearer credential with fixed redacted
  failure semantics;
- require an injected fetch capability and construct exactly one HTTPS
  `RunnerHttpClient` from ADR-086 transport/source authority;
- delegate to the retained ADR-087 lifecycle without exposing either graph;
- prove exact header, URL, timeout, response/source byte mapping and
  post-construction method capture;
- keep credential loading/refresh, environment, OCI/image bootstrap, process
  startup, shutdown, and activation out of scope.

Exit: adversarial and transport integrations prove configuration-before-secret
ordering, inert construction, exact authenticated client mapping, credential
redaction, one retained lifecycle, and no ambient or duplicate authority.

Admission: architecture commit `e1150cf` preceded implementation commit
`01c49fd`; 19 focused authenticated lifecycle tests and the strict heartbeat
transport regression passed, with all 1,077 runner-local tests and every local
repository gate green against fresh migrated PostgreSQL. Main CI run
`30728698907` passed every required Linux, PostgreSQL, API, runner, native
durability, Chromium journey, production-build, and evidence-upload gate.
ADR-088 is admitted. Credential loading/refresh, environment, trusted image
declarations, OCI/platform bootstrap, process startup, shutdown ownership, and
enablement remain deferred.

### Slice 2.52 — trusted image catalog configuration

Status: Admitted on 2026-08-02.

Architecture decision: ADR-089.

Detailed plan: `docs/plans/slice-2.52-trusted-image-catalog-configuration.md`.

- admit one closed, bounded V1 trusted-image catalog from unknown data;
- replace duplicate image reference/manifest authority with one bare digest;
- share hardened plain-data traversal with ADR-086 while preserving its
  array-rejecting semantics;
- detach and deeply freeze every declaration, command, argument, and
  environment entry;
- reject mutable references, aliases, duplicates, credential-like environment,
  sparse/custom arrays, accessors, cycles, and configuration bombs;
- keep loaders, image inspection/handshake, process and OCI construction,
  startup, shutdown, and activation out of scope.

Exit: adversarial and property tests prove one digest authority, bounded closed
data, deterministic detached admission, fixed redacted failure, downstream
catalog compatibility, and zero external effects.

Admission: architecture commit `c27534b` and bounding commit `87f9519`
preceded implementation commit `8b950d6`; 53 trusted-image parser tests, nine
catalog tests, the preserved 78-test ADR-086 suite, and all 1,138 runner-local
tests passed with every local repository gate green against fresh migrated
PostgreSQL. Main CI run `30730132598` passed every required Linux, PostgreSQL,
API, runner, native durability, Chromium journey, production-build, and
evidence-upload gate. ADR-089 is admitted. Catalog loading, OCI/platform
bootstrap, process startup, shutdown ownership, feature flags, and enablement
remain deferred.

### Slice 2.53 — OCI platform composition

Status: Admitted on 2026-08-02.

Architecture decision: ADR-090.

Detailed plan: `docs/plans/slice-2.53-oci-platform-composition.md`.

- parse ADR-086 and ADR-089 before reading an external capability;
- capture one injected process executor, host inspector, epoch clock, and
  ephemeral probe-identity source without constructing system adapters;
- map every engine, ownership, output, protocol, and derived probe-profile
  bound exactly into one readiness/backend/inspector/handshake/catalog graph;
- expose only the frozen image-admission and sandbox-owner operations required
  by the existing attempt lifecycle;
- prove inert construction, dependency capture, one shared authority graph,
  fixed redacted failures, and no ambient fallback;
- keep environment/credential loading, concrete system adapters, lifecycle
  composition, process entry, shutdown, feature flags, and activation out of
  scope.

Exit: adversarial and behavioral composition tests prove configuration-first
ordering, exact policy derivation, one process/host/clock/identity authority,
catalog/backend sharing, immutable ports, zero construction effects, and no
runner activation.

Admission: architecture commit `64f6299` preceded implementation commit
`48f641b`; 18 platform tests, ten identity-source tests, 24 backend tests, six
handshake tests, and all 1,168 runner-local tests passed with every local
repository gate green against fresh migrated PostgreSQL. The final local
Chromium journey passed against `socrates_ci_adr090_e2e`. Main CI run
`30731093798` passed every required Linux, PostgreSQL, API, runner, native
durability, Chromium journey, production-build, and evidence-upload gate.
ADR-090 is admitted. Concrete system adapters, loaders, lifecycle bootstrap,
process entry, shutdown ownership, feature flags, and activation remain
deferred.

## Acceptance gates

1. No model-provider dependency exists.
2. API and web dependency graphs contain no process-execution package.
3. V1 placeholder tasks cannot be claimed.
4. Unsupported protocol versions fail before a lease is created.
5. Capability matching is exact and default-deny.
6. Two concurrent claims yield one lease fence.
7. A stale fence cannot heartbeat, append, cancel, or complete.
8. Duplicate events are idempotent; gaps are rejected with the expected cursor.
9. Task creation and outbox publication survive dispatcher crashes.
10. Runner restart resumes from acknowledged evidence without duplication.
11. Cancellation survives API and runner restarts.
12. Terminal states cannot change.
13. Retry creates a distinct attempt and requires `retrySafe`.
14. Every budget dimension has a hard-limit test.
15. Network access fails without an explicit grant.
16. No host path or environment secret is visible by default.
17. Container privilege escalation and Docker socket access fail.
18. Fork bomb, memory pressure, disk fill, and timeout remain contained.
19. Cleanup removes sandboxes after every terminal path and lease expiry.
20. Logs are bounded, redacted, and rendered as inert text.
21. Artifact traversal, digest mismatch, oversize, and quota violations fail.
22. Measurement validation uses the frozen run metric protocol.
23. Deterministic decision results match the manual Phase 1 path.
24. Timeline and context rail reconcile from durable control-plane state.
25. The executable adapter is disabled when its feature flag is absent.

## Required quality gates

```text
pnpm format:check
pnpm typecheck
pnpm lint
pnpm test
pnpm audit:phase-2
pnpm test:e2e
pnpm build
```

`audit:phase-2` will preserve the API and web process boundary and reject model
providers. Real-container tests may run in a dedicated CI job because they
require an OCI engine; the merge gate must not silently skip them.

## Stop conditions

Implementation stops for architecture review if:

- the chosen backend requires privileged containers or the host Docker socket;
- runner identity depends only on network location;
- a required budget cannot be enforced outside experiment code;
- a contract exposes host filesystem paths;
- cancellation can race into two terminal outcomes;
- logs or artifacts require unbounded PostgreSQL growth; or
- the work begins to introduce hypothesis generation or automatic iteration.
