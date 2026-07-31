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

Status: Blocked on native Linux reference-host evidence.

Architecture decision: ADR-041.

Detailed plan: `docs/plans/oci-engine-spike.md`.

- compare supported OCI backends against the sandbox policy
- record host-platform requirements and measured cold-start cost
- prove hard cancellation and orphan cleanup
- run adversarial mount, network, privilege, fork-bomb, disk-fill, and secret
  leakage tests
- write the engine-selection ADR

Exit: a reviewed spike selects the backend. Spike code is not promoted by
default.

### Slice 2.5 — guarded local adapter

- implement the selected adapter without importing it into API or web
- require explicit runner bootstrap and `LOCAL_RUNNER_ENABLED=true`
- perform startup capability and policy self-checks
- reject execution when an enforcement primitive is unavailable
- add one real-container end-to-end experiment

Exit: one manually authored experiment produces a measurement and full
provenance inside a disposable sandbox.

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
