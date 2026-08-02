# Socrates Architecture

Status: Accepted for the product skeleton  
Last updated: 2026-07-31  
Scope: Web application shell and the future autoresearch platform boundary

## 1. Product definition

Socrates is a web-first autoresearch platform. A user defines an objective,
measurement protocol, constraints, and budget. Socrates then proposes
hypotheses, executes controlled experiments through a runner, measures outcomes,
keeps or rejects changes, and accumulates reusable knowledge.

Socrates is not a chat application. Its primary object is an experiment and its
primary interface is an experiment timeline.

The durable loop is:

```text
Objective
  -> Baseline
  -> Hypothesis
  -> Planned action
  -> Controlled execution
  -> Measurement
  -> Decision
  -> Knowledge
  -> Next hypothesis
```

Each iteration must answer:

1. What did we believe?
2. What exactly changed?
3. How was it measured?
4. Did it improve the target metric within the constraints?
5. What should future iterations remember?

## 2. Research findings

The initial architecture is informed by these systems:

- [Karpathy autoresearch](https://github.com/karpathy/autoresearch) demonstrates
  that autonomous optimization becomes tractable when the editable surface is
  narrow, the metric is explicit, and every experiment receives the same time
  budget. Socrates generalizes this protocol without generalizing away its
  discipline.
- [Sakana AI Scientist v2](https://github.com/SakanaAI/AI-Scientist-v2)
  separates ideation from execution, uses an experiment manager, supports
  parallel search branches, and explicitly warns that model-written code must
  run in a controlled sandbox. Socrates keeps a linear timeline in the first UI
  while preserving parent experiment relationships for future tree search.
- [OpenAI Evals](https://github.com/openai/evals) reinforces the separation
  between datasets, evaluation logic, model/system execution, and result
  records. Socrates treats a metric definition as versioned configuration, not
  display metadata.
- [SWE-ReX](https://github.com/SWE-agent/swe-rex) exposes one runtime interface
  across local containers and remote execution backends. Its separation of
  agent logic from runtime infrastructure supports Socrates' provider-neutral
  runner boundary.
- [OpenHands Runtime](https://docs.openhands.dev/openhands/usage/architecture/runtime)
  uses a client-server boundary around disposable Docker environments and
  content-derived runtime images. Its documented warnings around network
  access, credentials, and host mounts reinforce that a container alone is not
  a complete security policy.

The product implication is that the experiment ledger, measurement contract,
budget enforcement, and runner isolation are foundational. Agent prompts and
model providers are replaceable strategies.

## 3. Architecture principles

1. **Measurement before autonomy.** A run cannot start without a baseline,
   metric direction, evaluation protocol, and budget.
2. **Append facts; derive views.** Experiment events and observations are
   immutable. Current status, best result, and budget consumption are derived.
3. **Separate control plane and execution plane.** The web/API system schedules
   and observes work. Runners execute untrusted or resource-intensive actions.
4. **Domain core has no framework dependency.** Research rules live in a pure
   TypeScript package and do not import Next.js, Hono, Drizzle, or a provider SDK.
5. **Contracts cross process boundaries.** Runner and realtime payloads are
   versioned schemas.
6. **One primary metric, explicit constraints.** A project may observe many
   metrics, but acceptance is deterministic around one primary metric and
   guardrails.
7. **Reproducibility is a product feature.** Every experiment records its input
   revision, environment, action, metric protocol version, artifacts, and cost.
8. **Progressive distribution.** The first implementation is a modular monolith.
   Local, cloud, and distributed runners plug into the same execution contract.
9. **Performance over ornament.** Server-rendered routes, small client islands,
   restrained realtime updates, and no animation dependency by default.
10. **Accessible, keyboard-first UI.** Dense developer tooling must remain
    navigable without a pointer.

## 4. System context

```text
Browser
  |
  | HTTPS / SSE
  v
Next.js web application
  |
  | typed HTTP
  v
Hono API (control plane) ---- PostgreSQL
  |
  | versioned runner protocol
  v
Runner gateway
  +---- local runner
  +---- cloud runner
  +---- distributed runner pool
```

### Control plane

Owns users, workspaces, projects, objectives, metric definitions, runs,
experiment metadata, decisions, learnings, budget accounting, scheduling, and
realtime projections.

### Execution plane

Owns workspace checkout, isolation, commands/tools, resource limits, log
streaming, artifact upload, measurement invocation, cancellation, and cleanup.
It never decides product authorization and never mutates control-plane records
directly.

## 5. Monorepo

```text
apps/
  web/                 Next.js App Router product UI
  api/                 Hono control-plane API
packages/
  contracts/           versioned schemas and shared DTOs
  domain/              research entities, policies, state transitions
  database/            Drizzle schema, migrations, repositories
  design-system/       tokens and reusable UI primitives
  config/              shared TypeScript, lint, and Tailwind configuration
services/
  runner-local/        future local execution adapter
  orchestrator/        future scheduling and research loop
```

Dependency direction:

```text
apps/services -> contracts + domain + database/design-system
database      -> domain-compatible persistence types
domain        -> no framework package
contracts     -> schema library only
```

Apps may compose packages. Packages must not import apps or services.

## 6. Domain model

### Workspace

Tenant and authorization boundary.

### Project

Long-lived optimization target. Contains the objective, source target,
primary metric, constraints, and accumulated knowledge.

### MetricDefinition

Versioned measurement contract:

- name and unit
- direction: maximize or minimize
- evaluator type and configuration
- sample protocol
- aggregation
- acceptance threshold
- guardrail metrics

Changing the evaluation protocol creates a new version. Results from incompatible
versions are not ranked together by default.

### Run

A bounded research session for one project:

- objective snapshot
- baseline observation
- budget
- runner requirements
- strategy configuration
- status
- start and end timestamps

### Experiment

One testable iteration:

- sequence number
- optional parent experiment
- hypothesis
- planned action
- source revision before and after
- metric before and after
- observed constraint metrics
- decision
- learned knowledge
- cost and duration
- failure classification

### Observation

An immutable measurement with protocol version, value, sample metadata,
environment fingerprint, and artifact references.

### Learning

Durable knowledge extracted from evidence. Learnings carry confidence,
supporting experiment references, tags, and lifecycle status. Contradictory
evidence lowers confidence or supersedes a learning; it does not erase history.

### Artifact

Metadata for logs, diffs, reports, datasets, checkpoints, screenshots, or other
runner outputs. Binary content belongs in object storage, not PostgreSQL.

### Budget

Limits and derived usage for wall-clock time, model tokens/cost, compute cost,
experiment count, and optional domain-specific resources.

## 7. State machines

### Run

```text
draft -> queued -> preparing -> running -> paused -> running
                                  |           |
                                  +---------> cancelling -> cancelled
                                  |
                                  +---------> completed
                                  +---------> failed
                                  +---------> budget_exhausted
```

### Experiment

```text
proposed -> queued -> executing -> measuring -> evaluating
                           |                       |
                           +-> failed              +-> kept
                                                   +-> discarded
                                                   +-> inconclusive
```

Transitions are validated in the domain package. Status cannot be set through a
generic database update.

## 8. Experiment protocol

Executable runners accept only an immutable `ExperimentTaskV2`. The original
V1 skeleton contract remains parseable for stored compatibility fixtures but
cannot be claimed:

```ts
type ExperimentTaskV2 = {
  version: "2";
  taskId: string;
  runId: string;
  experimentId: string;
  source: ContentAddressedSnapshot;
  hypothesis: string;
  action: DeclaredCommandSequence;
  measurement: FrozenMetricProtocol & { command: DeclaredCommand };
  constraints: FrozenConstraint[];
  environment: OciEnvironmentRequirements;
  budget: RunnerBudget;
};
```

The runner emits ordered, idempotent events:

```ts
type RunnerEventV2 =
  | WorkspacePrepared
  | ActionStarted
  | ActionCompleted
  | LogAppended
  | ArtifactProduced
  | MeasurementRecorded
  | TaskSucceeded
  | TaskFailed
  | TaskCancelled;
```

Each V2 event carries `eventId`, `runnerId`, `taskId`, `attemptId`, lease fence,
monotonically increasing attempt-local `sequence`, timestamp, schema version,
and payload. The API acknowledges duplicate event IDs idempotently, rejects a
stale fence, and rejects sequence gaps with the expected next sequence.

## 9. Decision policy

Decision-making is deterministic and separate from hypothesis generation:

1. Validate the observation against its metric protocol.
2. Verify all hard constraints and guardrails.
3. Compare against the experiment's recorded baseline, not a mutable dashboard
   value.
4. Apply direction, minimum improvement, noise tolerance, and confidence rules.
5. Produce `kept`, `discarded`, or `inconclusive` with machine-readable reasons.
6. Allow a human override, but preserve both the automated and final decision.

This avoids an agent rationalizing a weak result after execution.

## 10. Persistence

PostgreSQL is the system of record. Drizzle owns schema and migrations.

Initial logical tables:

- `workspaces`, `workspace_members`
- `projects`, `project_sources`
- `metric_definitions`, `constraint_definitions`
- `runs`, `run_budgets`
- `experiments`, `experiment_actions`
- `observations`, `decisions`
- `learnings`, `learning_evidence`
- `artifacts`
- `run_events`
- `runner_registrations`, `runner_tasks`

Identifiers use UUIDv7-compatible values for sortable, globally unique IDs.
Money is stored in integer minor units. Metric values use numeric columns plus
unit metadata. Timestamps are UTC `timestamptz`.

`run_events` is an append-only audit and realtime source, not a full event-sourced
replacement for transactional domain tables. Transactional writes update domain
records and append their event atomically.

## 11. API and realtime

API prefix: `/v1`.

Resource groups:

- `/projects`
- `/projects/:projectId/runs`
- `/runs/:runId`
- `/runs/:runId/experiments`
- `/experiments/:experimentId`
- `/projects/:projectId/learnings`
- `/runners` and `/runner-tasks` for execution-plane communication

Commands use explicit endpoints such as `POST /runs/:id/start` rather than
generic status patches.

SSE is the default browser transport for run timelines because the main flow is
server-to-client, reconnectable, cache-friendly, and operationally simple.
WebSocket remains reserved for future bidirectional interactive sessions.

SSE events carry a durable event cursor. Reconnects use `Last-Event-ID`, and the
client always reconciles from an API snapshot after a gap.

## 12. Frontend architecture

Next.js App Router is responsible for routing, layouts, server-rendered initial
data, metadata, and error boundaries. Hono remains the application API; Next.js
route handlers are not a second business backend.

Route map:

```text
/                         dashboard
/projects/:projectId      project overview
/projects/:projectId/runs/:runId
/projects/:projectId/runs/:runId/experiments/:experimentId
/learnings
/settings
```

The application shell has a narrow sidebar, primary content column, and optional
context rail. Run pages use the experiment timeline as the dominant surface.

Zustand is limited to ephemeral client state such as sidebar state, local
filters, timeline selection, and transient realtime reconciliation. Server data
is not mirrored wholesale into a global store.

## 13. Design system

The interface language is English.

Visual constraints:

- black and near-black surfaces only
- neutral text with one restrained semantic accent
- maximum radius: `6px`
- borders: `1px`
- no gradients, glow, glass effects, or decorative motion
- typography and spacing create hierarchy
- tabular numerals for metrics, time, and budget
- iconography is functional and consistently sized

Token groups:

- color: canvas, surface, elevated, border, border-strong, text, muted, success,
  warning, danger, accent
- type: sans, mono; 12–28px product scale
- space: 4px base unit
- radius: 2px, 4px, 6px
- layout: 232px sidebar, fluid content, 304px context rail

Reusable primitives belong in `packages/design-system`; product compositions
remain in `apps/web`.

## 14. Security model

Executing agent-authored actions is high risk. Before any functional runner is
enabled:

- isolate each task in an ephemeral sandbox
- default-deny network access and allowlist destinations per project
- issue short-lived, task-scoped credentials
- mount source through a disposable workspace
- enforce CPU, memory, disk, process, time, and cost limits outside the agent
- redact secrets before log persistence
- require explicit capability grants for write, network, and external side
  effects
- preserve immutable command, diff, artifact, and decision audit records
- support immediate cancellation and guaranteed cleanup

The web/API process must never execute arbitrary experiment commands.

## 15. Reliability and observability

- Idempotency keys on create and command endpoints.
- Transactional outbox for task dispatch and external event publication.
- Leases and heartbeats for runner tasks; expired leases may be retried only
  when the action contract is retry-safe.
- Structured logs with workspace, project, run, experiment, task, and trace IDs.
- Metrics for queue latency, experiment duration, failure class, runner
  utilization, event lag, budget deviation, and acceptance rate.
- Failure taxonomy: infrastructure, invalid action, evaluation, budget,
  cancellation, and policy.

## 16. Testing strategy

- Domain: unit and property tests for state transitions, decisions, budgets,
  and metric comparison.
- Contracts: schema compatibility fixtures for every protocol version.
- Database: migration and repository integration tests against PostgreSQL.
- API: command authorization, idempotency, transaction, and SSE resume tests.
- Web: component tests for product states and route-level end-to-end tests.
- Runner: adversarial tests for timeout, cancellation, log redaction, resource
  exhaustion, and duplicate delivery.

## 17. Delivery phases

### Phase 0 — product skeleton (complete)

- monorepo and shared tooling
- design tokens and UI primitives
- dashboard, project, run, experiment, learnings, and settings screens
- typed domain and contract placeholders
- Hono health/readiness surface and module boundaries
- realistic read-only fixture data
- no autonomous execution

### Phase 1 — measured manual experiments (complete)

- implementation plan:
  [`docs/plans/phase-1-measured-experiments.md`](docs/plans/phase-1-measured-experiments.md)
- PostgreSQL and migrations
- project/run creation
- versioned metrics and baselines
- manually recorded experiments and decisions
- durable event timeline

Phase 1 remains manual by design. Its acceptance gate explicitly forbids runner,
shell executor, and model-provider dependencies.

### Phase 2 — local runner (planned)

- implementation plan:
  [`docs/plans/phase-2-runner-foundations.md`](docs/plans/phase-2-runner-foundations.md)
- research record:
  [`docs/research/execution-platforms.md`](docs/research/execution-platforms.md)
- task protocol and runner registration
- sandboxed local execution
- logs, artifacts, cancellation, and budgets
- deterministic decision policy

Phase 2 is split into a control-plane foundation and an explicitly enabled
sandbox adapter. It does not introduce an LLM provider, hypothesis generator,
or autonomous research loop. Host-process shell execution is prohibited.

### Phase 3 — research loop

- provider-neutral hypothesis strategy
- experiment planner and knowledge extraction
- pause/approval policies
- evaluation of loop quality

### Phase 4 — cloud and distributed runners

- runner pools, capabilities, leases, scheduling
- object storage
- parallel branches and search strategies
- tenant-level quotas and billing controls

## 18. Accepted decisions

### ADR-001: Modular monolith first

The API begins as a modular monolith. Process boundaries are introduced only for
execution, isolation, or independently scaled workloads.

### ADR-002: Hono is the sole business API

Next.js renders the product and consumes Hono. Business rules are not duplicated
in Next.js route handlers or Server Actions.

### ADR-003: SSE before WebSocket

Run updates are predominantly one-way. SSE supplies reconnection semantics with
less operational complexity.

### ADR-004: Runner contract before runner implementation

Local, cloud, and distributed execution must implement one versioned protocol.
The local runner is not allowed to become an implicit architecture.

### ADR-005: Linear UI, graph-capable data

The first product presents a clear experiment timeline. `parentExperimentId`
preserves future best-first, beam, and parallel search without forcing graph UI
complexity into the skeleton.

### ADR-006: Fixture-backed skeleton

Phase 0 uses typed, realistic fixtures through a repository-shaped interface.
It does not introduce fake persistence or nonfunctional control endpoints.

### ADR-007: Routes resolve resources through one read boundary

Even fixture-backed pages resolve projects, runs, and experiments through typed
selectors instead of embedding resource data in route components. Dynamic
routes return `notFound()` for unknown identifiers. This keeps route behavior
compatible with a future API-backed repository and prevents misleading screens
that render valid-looking data for invalid URLs.

### ADR-008: Product states are part of the skeleton

Loading, not-found, and unexpected-error surfaces are first-class product
states. They share the design system and must not expose raw framework errors.
Route metadata is derived from the same resolved resource used by the page.

### ADR-009: One reproducible quality gate

Local development and continuous integration run the same root scripts with the
package manager version pinned in `package.json`. CI installs from the committed
lockfile without mutation, has read-only repository permissions, and must pass
format, typecheck, lint, unit tests, and the production build before changes are
considered mergeable.

### ADR-010: Responsive hierarchy and honest affordances

Product headers stack title content before actions below the small-screen
breakpoint so controls never compress the primary reading measure. Mobile
navigation behaves as a modal drawer and locks background scrolling while open.
Phase 0 renders future commands as explicitly disabled controls with a concise
availability hint; controls that appear enabled must navigate or perform a real
local interaction.

### ADR-011: Manual ledger before autonomous execution

Phase 1 implements durable measurement, deterministic decisions, idempotent
commands, and resumable event delivery without an agent or runner. The accepted
implementation sequence and exit criteria live in
[`docs/plans/phase-1-measured-experiments.md`](docs/plans/phase-1-measured-experiments.md).
Autonomous execution cannot begin until that plan's acceptance matrix passes.

### ADR-012: Exact decimal metrics in the domain

Metric values and thresholds cross contracts as canonical decimal strings.
Domain arithmetic parses them into a signed `bigint` coefficient and decimal
scale, aligns scales explicitly, and never compares persisted measurements with
JavaScript floating-point arithmetic. Units are part of every metric value and
must match the protocol before comparison. This implementation remains inside
`packages/domain`; database and transport layers persist or transmit strings.

### ADR-013: Domain modules before application adapters

Run lifecycle, experiment lifecycle, metric comparison, decision policy, and
budget policy live in separate framework-free domain modules. `index.ts` only
exports the public surface. Contracts define transport validation but do not
import domain implementations. Database, Hono, and React adapters may depend on
these packages; the reverse dependency is forbidden.

### ADR-014: Normalized PostgreSQL facts with generated migrations

Phase 1 persists normalized aggregate state separately from immutable evidence.
Observations, decisions, learnings, and run events are append-only through
repository APIs; mutable project, run, and experiment rows carry optimistic
concurrency versions. Metric decimals remain canonical strings with database
checks instead of being coerced through JavaScript floating point. Durations
and minor-unit costs use PostgreSQL `bigint` while application contracts keep
them inside JavaScript's safe-integer range.

The Drizzle TypeScript schema is the code-first source of truth. Reviewed SQL,
snapshots, and the migration journal are committed together. Schema modules are
grouped by domain, re-exported from one migration entry point, and validated
with `drizzle-kit check`. Application code may apply committed migrations but
must never use `drizzle-kit push` against shared environments.

### ADR-015: Workspace-scoped reads with opaque cursors

Phase 1 read APIs receive their workspace scope as an application dependency;
clients cannot select a workspace through query parameters before
authentication exists. Database adapters return plain persistence records and
remain the only code allowed to import Drizzle schema objects. Hono modules map
those records to response contracts and centralize not-found, validation, and
dependency-unavailable errors.

List resources use a stable descending `(created_at, id)` keyset. Public cursors
are versioned base64url values owned by the API, not serialized database types.
Run event replay is the exception: its durable, monotonically increasing
run-local sequence is already the public cursor. List queries fetch one extra
row to derive `nextCursor` without a count query.

### ADR-016: Bundled Node control-plane artifact

The Hono control plane builds as one Node 22 ESM artifact. The bundle includes
workspace packages and runtime dependencies, so production execution does not
depend on TypeScript source exports or extensionless TypeScript emit resolving
inside `node_modules`. Type checking remains a separate required gate; bundling
does not replace it. The build script may clean only `apps/api/dist`, emits a
source map, and the production `start` command runs the generated JavaScript
with plain Node.

### ADR-017: Command transactions own one aggregate version

Every command is an application use case, never a generic row update. The
application claims the idempotency key, locks records in the stable
`workspace -> project -> run -> experiment` order, verifies the supplied
aggregate version, applies domain policy, persists facts, and stores the exact
successful HTTP response in one PostgreSQL transaction. Policy-rejected
commands roll back both the claim and any attempted writes. A successful
command increments its target aggregate version exactly once even when a
manual lifecycle command traverses internal states such as
`draft -> queued -> preparing -> running`.

Run-scoped commands append at least one durable `run_events` row in the same
transaction. Workspace/project commands occur before a run exists, so their
atomic audit boundary is the idempotency record until a broader control-plane
event log is introduced. Child creation locks and versions its parent:
creating a run versions the project; proposing an experiment versions the run.
Evidence rows remain immutable. Observation and learning commands version the
experiment that owns the new evidence.

Project and metric-definition mutations return the generated constraint IDs
alongside the current metric ID. Clients therefore never infer persistence
identifiers and can address guardrail observations explicitly.

Application errors are typed and mapped centrally. Missing workspace-scoped
resources return `404`, stale versions return `409 version_conflict`, reused
idempotency keys return `409 idempotency_conflict`, invalid lifecycle commands
return `409 invalid_transition`, exhausted budgets return `409
budget_exhausted`, and metric mismatches return `422 protocol_mismatch`.

### ADR-018: Observation identity is explicit

Baseline, before, and after observations identify the immutable primary metric
definition. Guardrail observations instead identify one immutable constraint
definition; they do not overload the primary metric ID. PostgreSQL enforces the
exclusive identity shape and permits only one before value, one after value,
and one value per guardrail constraint for an experiment in Phase 1.

Decision evaluation loads the run's frozen metric definition, both primary
observations, every hard constraint, and its matching observation. Missing
required evidence makes the automated decision inconclusive. Present
constraints are compared with exact decimal arithmetic and explicit units;
failed hard constraints discard the experiment. Soft constraints remain
recorded evidence but do not change the Phase 1 keep/discard result.

### ADR-019: Command modules follow aggregate ownership

Command code is partitioned by the aggregate whose version and invariants the
use case owns: project, run, or experiment. HTTP route modules follow the same
boundary and only validate transport input before calling an application use
case. Shared idempotency execution, error mapping, event append helpers, and
response transport remain small infrastructure modules rather than a fourth
business module.

Creating a child belongs to the parent command module when the parent is the
versioned transaction target. Creating a run is therefore a project command,
while proposing an experiment is a run command. This keeps lock ownership and
optimistic concurrency visible at the module boundary and prevents a single
control-plane service or route registry from accumulating every lifecycle.

### ADR-020: One durable run-event feed, two representations

`GET /v1/runs/:runId/events` remains the canonical run-event resource. Normal
HTTP requests receive the existing paginated JSON representation. Requests
whose `Accept` header includes `text/event-stream` receive an SSE feed, avoiding
a second URL with different cursor semantics.

Each SSE message uses the durable run-local sequence as `id`, `run-event` as
the event name, and the public run-event resource JSON as data. On reconnect,
a valid `Last-Event-ID` takes precedence over the `after` query parameter.
Invalid, negative, or unsafe cursor values fail before streaming with the
normal validation error envelope. The server first drains every committed
event after the cursor, then waits on a process-local notifier with periodic
database reconciliation. Notifications only occur after the idempotent command
transaction commits and are latency hints, never event payloads or truth.

Heartbeat comments are emitted on idle connections without advancing the
cursor. Writes respect stream backpressure. Aborted clients release notifier
subscriptions and timers. A slow or disconnected client can always reconnect
from its last durable event ID; the server does not maintain per-client event
buffers. Process shutdown stops accepting new requests and gives active
connections a bounded drain window before closing them, so SSE clients cannot
block deployment indefinitely.

### ADR-021: Timeline reads are evidence-enriched projections

Experiment list and detail reads return the evidence needed to render the
primary product surface: before/after and guardrail observations, the current
decision, and linked learnings. These are read projections over immutable
facts, not duplicated mutable columns on the experiment row. Project detail
also exposes the generated guardrail definitions for its current metric
protocol.

The PostgreSQL adapter pages experiment rows first, then hydrates the selected
page with bounded batch queries keyed by those experiment IDs. It must not
issue one evidence query per experiment. List ordering and cursor derivation
continue to depend only on the base experiment rows, so concurrent evidence
appends cannot reorder or duplicate timeline pages. API contracts expose plain
resources; Drizzle records and query-specific shapes remain inside the
database package.

### ADR-022: The web validates one control-plane contract at runtime

Server Components call the Hono control plane through the server-only
`SOCRATES_API_URL`. Browser commands and EventSource connections use the
same-origin `/control-plane/*` transport, which Next.js rewrites to that
service. The rewrite is network plumbing only; Next.js does not implement
business endpoints or import database code.

One web client owns URL construction, request defaults, error-envelope parsing,
and response validation with schemas from `@socrates/contracts`. Mutable
research reads use `no-store` until an explicit cache invalidation protocol
exists. A non-success response becomes a typed recoverable API error; a
successful response that violates its schema becomes a distinct contract
violation and is never rendered as trusted data. The development default is
`http://127.0.0.1:3001`; deployed environments must set the internal API URL
to their control-plane service.

### ADR-023: Cross-project knowledge is a workspace projection

The global Learnings surface reads `GET /v1/learnings`, a workspace-scoped,
cursor-paginated projection. It does not fan out one request per project.
Project-scoped knowledge remains available at
`GET /v1/projects/:projectId/learnings` for project and run context. Both
representations share the same learning resource and stable created-at cursor
ordering.

Workspace identity continues to come from the control-plane boundary in Phase
1, never from a caller-supplied query parameter. The database query joins
projects to enforce workspace isolation before pagination. Project names are
resolved from the already required project summary projection in the web
surface; the learning record remains normalized and carries only `projectId`.

### ADR-024: Manual commands are progressive, refresh-reconciled workflows

Phase 1 command UI follows the aggregate lifecycle instead of presenting one
large research wizard. Project creation has a dedicated route. Run creation,
baseline entry, run start, experiment proposal, observation entry, decision,
and learning entry are exposed only when the current resource state permits
the corresponding command. Disabled controls explain which prerequisite is
missing.

Client Components own transient form state and call the same-origin typed
control-plane client. Server Components remain the snapshot authority. After a
successful command the client navigates to a newly created resource or calls
`router.refresh()` for an existing route. No optimistic domain facts are
invented locally.

Each semantic submission owns a cryptographically random idempotency key that
is retained while the same payload is retried after an ambiguous transport
failure. Editing the payload allocates a new key. Validation and domain errors
preserve input. A `version_conflict` preserves input, identifies the stale
snapshot, and refreshes server data before another submission.

The run projection includes its latest durable event sequence. The timeline
enhances that server snapshot with the SSE feed starting after this sequence.
The client stores only the highest contiguous event sequence and connection
state; event payloads are invalidation signals, not a second experiment
projection. Receiving a new durable event schedules one coalesced
`router.refresh()`. EventSource reconnect supplies the last sequence through
the query cursor, and the server remains responsible for replay. Zustand is not
used for durable research facts.

### ADR-025: Web acceptance tests cross the real process boundaries

Phase 1 browser acceptance tests run Chromium against the Next.js development
server, the Hono API, and a migrated PostgreSQL database. They do not intercept
control-plane requests or replace command responses with fixtures. A dedicated
development seed command establishes the single-tenant workspace and stable
reference records before the servers start; each journey creates uniquely
named resources and asserts only its own resulting facts.

Playwright owns repeatable browser automation, failure screenshots, and traces.
The CI PostgreSQL service is migrated and seeded explicitly, then one Chromium
project exercises project creation through run completion. The journey also
checks durable SSE connection state, the learning projection, framework error
overlays, and horizontal overflow at a 390-pixel viewport. Unit and API tests
remain the primary exhaustive coverage; browser tests cover one critical
cross-process story rather than duplicating every domain permutation.

Acceptance servers use dedicated, configurable test ports and never reuse an
existing listener. Readiness on a common development port is not proof that the
process belongs to Socrates and could otherwise send the browser journey into
an unrelated local application.

### ADR-026: Run detail projections carry their frozen metric protocol

Creating a metric revision appends an immutable definition and advances the
project's current protocol. It never mutates an existing run. New runs must
reference the latest project definition, while every existing run continues to
measure and decide against the definition captured by its
`metric_definition_id`.

The run detail API therefore includes the complete frozen metric definition,
including guardrails. Run list resources remain compact and expose only the
definition ID. Run and experiment screens must use the run detail protocol for
labels, observation commands, decision presentation, and guardrail collection;
they must not read those values from the project's current metric. This makes a
project revision safe while older draft, active, or completed runs remain
viewable and operable.

The project screen owns metric revision. The form starts from the current
definition, submits the complete next definition with the expected project
version, and treats guardrails as a full replacement for the new version.
Revision is explicit and confirmed because it changes the protocol used by all
subsequently created runs.

### ADR-027: Human decision overrides cannot bypass evidence validity

The decision command always evaluates the deterministic policy first and stores
its decision, reason, and calculated improvement. An operator may supply a
different final decision only with a non-empty reason; the automated result
remains immutable evidence beside the final result.

Overrides express accountable judgment about valid evidence, not permission to
erase safety constraints. A final `kept` decision is rejected when the
automated reason is `guardrail_failed` or `invalid_measurement`. Operators may
still choose `discarded` or `inconclusive`, and may override threshold- or
noise-based results in either direction with a reason. The API owns this
invariant so every client and future runner receives the same protection.

The experiment UI labels override controls as optional, explains that policy
evaluation still runs, and requires both a final decision and reason together.
After commitment, the evidence panel renders automated and final decisions
separately whenever they differ.

### ADR-028: Read indexes follow cursor scope and ordering

Every cursor-paginated read orders by `(created_at DESC, id DESC)` inside its
aggregate scope. PostgreSQL B-tree indexes therefore begin with the equality
scope and continue with `(created_at, id)`: workspace for projects, project for
runs and project learnings, and run for experiments. Hydration reads similarly
index experiment observations and decisions by their foreign key followed by
their evidence ordering columns. The global workspace learning projection also
has a `(created_at, id)` index; Phase 1 is single-workspace, so denormalizing a
workspace ID into immutable knowledge rows is deferred until multi-tenancy.

Index migrations are forward-only and reviewed alongside `EXPLAIN` evidence.
Tests assert the required index definitions by name so a later schema refactor
cannot silently remove the pagination contract. For the workspace learning
join, PostgreSQL may validly choose either the global order-first learning index
or the project-scoped learning index plus a bounded sort, depending on workspace
selectivity. Plan evidence verifies both ordering indexes independently and
requires the workspace projection to index both join sides; it does not freeze
one cost-based join strategy.

### ADR-029: Manual research and schema compatibility are startup gates

The deployed API exposes manual research commands only when
`MANUAL_RESEARCH_ENABLED=true`. Reads and health remain available while the
feature is disabled; command routes return the standard service-unavailable
envelope. The server treats absent, malformed, and false values as disabled.
Tests and local development opt in explicitly.

The database owns a singleton `socrates_schema_metadata` row with an integer
compatibility version. Every schema-breaking release advances the supported
version and updates the row in a committed migration. When `DATABASE_URL` is
configured, the API verifies that exact version before opening the listener. A
missing table, missing row, or different version fails startup rather than
serving against an unknown schema. This compatibility marker complements
Drizzle's migration history: migration hashes track application, while the
marker is the runtime contract.

### ADR-030: Phase 2 builds execution infrastructure, not autonomy

The first runner phase accepts only an immutable, operator-authored experiment
task. It may prepare a source snapshot, execute its declared action and
measurement steps, and return evidence. It cannot propose a hypothesis, mutate
the metric protocol, create the next experiment, or decide whether to continue
a run.

The control-plane foundation ships before the executable adapter. Runner tables,
task contracts, leases, event ingestion, cancellation state, and artifact
metadata can be exercised with a deterministic fake adapter. Enabling the OCI
sandbox requires a separate feature flag and the acceptance evidence in the
Phase 2 plan. This preserves the boundary between measured execution and the
Phase 3 research loop.

### ADR-031: Runners pull fenced leases from the control plane

A runner registers its kind, protocol versions, sandbox backend, and bounded
capabilities. Registration does not make the runner eligible for every task;
the scheduler matches an exact capability set and compatible protocol version.
Runners establish outbound authenticated connections and pull work. The control
plane never needs an inbound connection to a developer machine.

Claiming a queued task atomically creates an attempt with a monotonically
increasing fencing token and a short lease. Heartbeats renew only the current
fence. Every event, completion, and artifact commit carries the task ID,
attempt ID, and fence. The API rejects stale-fence writes, duplicate event IDs,
and non-contiguous sequences. An expired attempt remains immutable evidence;
retry creates a new attempt and is permitted only for a task whose action
contract is explicitly retry-safe.

Task dispatch uses a transactional outbox. The experiment transition and queued
task become durable in one database transaction; a dispatcher publishes only
committed outbox records. Delivery is at least once, while fenced claims and
idempotent ingestion make effects exactly-once from the domain's perspective.

### ADR-032: The first local runner is an OCI sandbox, never a host shell

Phase 2 supports a Linux OCI-compatible sandbox backend. Windows and macOS
development may reach it through Docker Desktop or an equivalent Linux VM, but
Socrates does not execute experiment commands directly through Node
`child_process` on the host.

Each attempt receives a fresh container, a read-only root filesystem, a
disposable copy-on-write workspace, a non-root user, dropped Linux
capabilities, `no-new-privileges`, a seccomp profile, bounded PIDs, CPU, memory,
disk, and wall time, and no host Docker socket. Network is disabled by default.
Any allowlisted egress is a task capability enforced outside the container and
recorded in provenance. Host bind mounts, privileged mode, host namespaces, and
unscoped environment inheritance are forbidden.

Source and runtime images are addressed by immutable digests. Cleanup is
idempotent and runs after success, failure, cancellation, runner restart, and
lease expiry. Sandbox escape resistance must be tested adversarially, but the
architecture does not claim that containerization alone is a security boundary.

### ADR-033: Cancellation and budgets are externally enforced facts

Cancellation is a durable control-plane request, not merely a signal sent to a
process. A runner that observes it first requests graceful termination, then
hard-stops the sandbox after a bounded grace period. Whichever terminal result
wins the fenced compare-and-set is final; later events are rejected. A task
never transitions from one terminal state to another.

Wall time, CPU, memory, PIDs, writable bytes, log bytes, artifact bytes, command
count, and permitted egress are explicit task limits. The runner and sandbox
backend enforce them independently of the action being executed. Crossing a
hard limit produces a typed budget or policy failure and cleanup. Partial logs
and artifacts remain attributable to the failed attempt.

### ADR-034: Logs and artifacts are bounded evidence, not trusted output

Runner output is untrusted. Logs are emitted as ordered, size-bounded chunks,
redacted before persistence, escaped on render, and never interpreted as
control messages. Redaction is defense in depth; task credentials remain
short-lived, capability-scoped, and absent unless required.

Binary outputs do not enter PostgreSQL. The runner uploads to a content-addressed
artifact store and then commits metadata containing digest, size, media type,
logical role, task attempt, and retention class. Phase 2 may use a local
filesystem implementation behind the artifact-store port; contracts must not
expose filesystem paths. The control plane accepts metadata only after digest
and size verification.

### ADR-035: Scheduler truth is transactional and database-clocked

Runner registrations are workspace-scoped control-plane records. A registration
must be active, advertise task/event protocol V2, and satisfy the task's closed
capability requirements before it can claim work. A caller-provided runner ID
is never sufficient authorization; deployment authentication remains a
separate adapter behind the registration boundary.

`runner_tasks` stores the immutable validated V2 task payload beside a small
relational scheduling projection: status, retry safety, current fence, and
timestamps. Each experiment owns at most one task; retries create immutable
`runner_task_attempts`, not replacement tasks. Claiming locks the registration
and task, increments the task fence, creates one attempt with that fence, and
changes the task to `leased` in one transaction. A unique `(task_id, fence)`
constraint and fenced compare-and-set writes prevent two active identities from
controlling the same task.

Lease issue, renewal, expiry, and cancellation timestamps use PostgreSQL's
clock. Runner clocks are provenance only and never decide lease validity.
Heartbeats update an attempt only when runner, task, attempt, fence, active
status, and unexpired lease all match. A failed predicate returns a typed stale
result without mutating evidence.

Task creation appends an `outbox_messages` row in the same transaction. The
outbox payload identifies the task; the immutable task body remains in
`runner_tasks`. A future dispatcher may claim unpublished outbox rows with
`FOR UPDATE SKIP LOCKED`, but the Phase 2.1 persistence slice does not introduce
a broker, background loop, or executor.

### ADR-036: Cancellation and lease reconciliation are serialized task commands

Each cancellation command carries a caller-generated request ID and workspace
scope. The request is inserted into an append-only
`runner_task_cancellations` record with one accepted request per task. In the
same transaction, a transaction-scoped advisory lock serializes the request ID
before the scheduler locks the task. Hash collisions can only add
serialization; they cannot merge records because the UUID remains the primary
key. The scheduler then either changes a queued task
directly to `cancelled` or changes a leased/running task to
`cancellation_requested`. Replaying the same request ID returns the committed
result; a different request after acceptance does not create a second record.
The task timestamp is a query projection, not the audit source. Every accepted
transition also appends an outbox message.

Runner terminal writes lock the task and attempt together and accept only the
current runner, attempt, fence, active attempt state, and unexpired database
lease. The task state must permit the requested terminal result. Both records
then become terminal in one transaction; a typed stale or invalid-transition
result performs no write. Failure classification is required only for failed
attempts. Terminal task and attempt rows are never rewritten.

Lease reconciliation selects expired active attempts with
`FOR UPDATE SKIP LOCKED` in bounded batches. It marks each selected attempt
`expired` before changing the task projection. A cancellation-requested task
becomes `cancelled`; otherwise an explicitly retry-safe task returns to
`queued`, while a non-retry-safe task becomes `failed`. Requeue preserves the
current fence, so the next claim advances it and stale writers remain fenced
out. Each outcome is recorded in the transactional outbox. The reconciler is a
callable persistence command in this slice; no timer, worker, or executor is
introduced.

### ADR-037: Runner acknowledgements commit evidence and state together

`runner_task_events` stores the validated V2 envelope as immutable attempt
evidence. Relational columns contain event, runner, task, attempt, fence,
attempt-local sequence, type, timestamps, and a digest of the normalized
envelope. Event ID is globally unique and `(attempt_id, sequence)` is unique.
The attempt row remains the acknowledgement cursor; an event is acknowledged
only after both its row and the new cursor commit.

An exact event-ID replay returns the original acknowledgement even after the
lease or task becomes terminal, which lets a restarted runner discard already
committed spool entries. Reusing an event ID or attempt sequence for different
normalized content is a conflict. A new event must match the current runner,
task, attempt, and fence; the attempt must be active and its database lease
unexpired. A sequence above the next cursor is rejected with the expected
sequence. A stale fence or an unseen sequence behind the cursor is rejected
without writing.

Lifecycle event ingestion owns its related state transition. Workspace
preparation advances the attempt to `preparing`; action start advances attempt
and task to `executing`/`running`; action completion preserves execution;
measurement advances the attempt to `measuring`; and terminal events update the
event, cursor, attempt, and task in the same transaction. Successful completion
requires measurement state, failure may terminate any active current attempt,
and cancellation requires a durable cancellation request. This removes the
crash window between acknowledging terminal evidence and committing the
terminal compare-and-set.

Every accepted non-log lifecycle event is also projected into the existing
run-event ledger while the run row is locked, so SSE readers reconcile from one
durable sequence. `log.appended` and `artifact.produced` are admitted through
the same cursor only under the quota, redaction, verification, and retention
rules in ADR-040. Parseability is not authorization to persist unbounded
evidence.

### ADR-038: Runner error semantics precede the authenticated transport

The API application layer owns a transport-neutral `RunnerGatewayService` that
invokes scheduler transactions and converts every non-success scheduler result
into the existing `CommandError` vocabulary. Attempt identity reuse, occupied
tasks, capability mismatch, stale fences, and event conflicts are
`resource_conflict`; lifecycle violations are `invalid_transition`; malformed
evidence and event kinds that are not yet supported are `protocol_mismatch`.
Sequence gaps are conflicts carrying the exact expected sequence. The
machine-readable scheduler cause is preserved as `details.runnerReason`.

Exact claim and event replays remain successful application results rather than
errors. This lets a future authenticated HTTP or streaming adapter return the
original acknowledgement without duplicating state.

This slice does not register runner routes in Hono. Runner authentication is
deployment-specific and remains a prerequisite; accepting caller-supplied
runner IDs on a public route would bypass ADR-031. The application service is
therefore tested directly and becomes the only allowed entry point for a later
authenticated transport adapter.

### ADR-039: The first vertical runner is deterministic and test-only

Slice 2.2 introduces a fake adapter under the execution-plane package's
`testing` namespace. It implements the runner port but is not exported from the
package's main entry point. Control-plane applications do not depend on
`@socrates/runner-local`; the vertical integration test drives the persistence
ports from the execution-plane package.

The fake validates a frozen `RunnerExecutionV1` and emits a deterministic V2
lifecycle: workspace preparation, ordered action start/completion pairs,
measurement, and terminal success. Event IDs are derived reproducibly from the
attempt identity and sequence. Durations and the synthetic measurement are
explicit fixture inputs. It never opens a process, filesystem, socket, browser,
container, or model provider, and it does not claim to measure real work.

Cancellation is an in-memory test signal checked between yielded events. A
cancelled fake execution emits one fenced terminal cancellation event at the
next sequence. Restart tests create a new fake instance and replay its
deterministic spool through the durable acknowledgement boundary. This adapter
proves orchestration semantics only; it cannot satisfy or bypass the guarded
OCI adapter gates.

### ADR-040: Evidence admission is quota-atomic and pathless

Slice 2.3 keeps log chunks in `runner_task_events`; a second log table would
duplicate ordering and replay semantics without adding an independent
aggregate. Each attempt stores accepted log and artifact byte counters. The
scheduler locks that attempt, checks the frozen task budget, inserts the event,
and advances the counter and acknowledgement cursor in one transaction.
Exhaustion returns a typed budget result without consuming a sequence number.
Exact replays never consume quota twice.

The runner's `redacted` flag is provenance, not proof. Before persistence, the
control plane applies a deterministic secondary redactor for high-risk token,
authorization, and private-key shapes, marks the persisted payload as redacted,
and recomputes its UTF-8 byte count. The post-redaction chunk must still satisfy
the protocol limit and aggregate budget. This filter is defense in depth, not
credential discovery; credentials remain absent by default and scoped by
capability when a later adapter requires them. UI renderers receive log text as
data and must escape it rather than interpreting HTML or control syntax.

Artifact bytes cross a separate `ArtifactStore` port before their event is
admitted. The port accepts bytes plus an expected SHA-256 digest and size,
streams into a private temporary object, verifies both limits, and publishes by
atomic rename under a digest-derived key. It returns an opaque verified-object
capability. The scheduler application boundary consumes only a matching,
verified capability when committing `artifact.produced`; callers cannot submit
a host path or storage key. PostgreSQL stores immutable content metadata and an
attempt-scoped artifact record, never the binary.

Artifact content identity is the digest, while the protocol `artifactId`
identifies its attempt-scoped metadata record. Repeated content may therefore
deduplicate across records without merging provenance. Metadata insertion,
artifact-byte accounting, event insertion, and cursor advancement are one
database transaction. Upload-before-metadata can leave an unreferenced object
after a crash, so local storage exposes enumeration and deletion only to a
future grace-period reconciler; request paths never delete objects. Metadata
cannot precede a verified object.

The local filesystem adapter receives its root through trusted bootstrap
configuration and derives every final and temporary path internally from a
strict lowercase SHA-256 digest. No protocol field is joined to a filesystem
path. Existing identical objects make upload idempotent; digest mismatch, size
mismatch, oversize input, malformed media type, traversal-shaped identifiers,
and quota exhaustion fail closed. Retention is recorded as an explicit class
on metadata; deletion policy remains out of scope until a durable reconciler
exists.

### ADR-041: OCI engine selection is an enforcement proof, not a CLI choice

The Phase 2.4 spike compares rootless Docker Engine, rootless Podman, and
rootless containerd through nerdctl. Similar command-line flags are not
equivalent guarantees. A candidate passes only when a Linux-native host probe
observes cgroup v2 with delegated CPU, memory, and PID controllers, seccomp, a
host LSM (AppArmor or SELinux), user-namespace isolation, and an engine that
reports the requested limits as active. Missing or silently ignored primitives
are failures, not warnings.

Docker Desktop on Windows or macOS may run the development spike, but it cannot
select the production backend. Its Linux VM, host-filesystem sharing, licensing
mode, and resource envelope differ from a native Linux runner. Measurements
from Desktop are recorded with their backend and host facts and remain
development evidence only. The reviewed selection requires a repeat run on the
documented native Linux reference host.

Every candidate receives the same default-deny profile: non-root process,
read-only root filesystem, size-bounded tmpfs mounts at `/workspace`, `/tmp`,
and `/dev/shm`, no engine-added writable temporary mounts, no host PID, IPC,
network, user, or cgroup namespace sharing, no devices, all capabilities
dropped, no-new-privileges, the engine's default seccomp profile, no host
environment inheritance, no Docker/containerd/Podman socket, and no bind mount
outside a runner-created source snapshot. Network mode `disabled` creates an
unconfigured network namespace rather than relying on application behavior.
Images must already exist by digest and implicit pulls are disabled; daemon log
storage is disabled because ordered bounded logs belong to the Socrates
evidence channel.

The spike proves enforcement from inside and outside the sandbox. It attempts
host-path and runtime-socket access, privilege gain, fork pressure, memory
pressure, workspace disk fill, DNS and direct-IP egress, environment-secret
discovery, and escape-relevant syscalls. Cancellation sends one bounded
graceful stop followed by a hard kill, then verifies that the container,
processes, mounts, networks, and temporary workspace are absent. Every object
uses a unique Socrates label so a crash-recovery sweep can enumerate only its
own orphans.

Cold-start latency is measured separately for cached-image create/start and
end-to-end run/remove paths after warm-up. Performance can choose between
candidates only after every security and cleanup gate passes. The spike harness
lives outside `apps`, `packages`, and `services`, is never imported by a
production package, and requires an explicit engine target. It cannot be
promoted into Slice 2.5 by copying commands; the guarded adapter must encode
typed arguments, startup self-checks, and cancellation ownership anew.

Native reference-host evidence is produced as one comparison session rather
than by manually combining independent files. Docker and Podman are required
candidates; nerdctl is measured when available. The session manifest fails
closed unless both required candidates produce complete evidence with the same
immutable image, sandbox profile, kernel, architecture, and cgroup version and
at least one candidate passes every native preflight, adversarial,
cancellation, and cleanup gate. A failed candidate remains valid comparison
evidence; requiring every candidate to be eligible would prevent the spike
from eliminating an engine. It may mark the evidence ready for architecture
review, but it cannot select or rank an engine; the reviewed ADR amendment
remains the selection authority.

Host LSM availability and sandbox LSM confinement are separate gates. The host
must have AppArmor or SELinux enabled, and the workload must observe an
enforcing, non-`unconfined` security label. Docker documents AppArmor as
unsupported in rootless mode, so rootless Docker is expected to fail the
sandbox LSM gate unless a different supported host LSM is proven. This is a
selection result, not permission to weaken the policy.

Engine metadata is discovery evidence, not the final LSM proof. On an AppArmor
host, the reference-host operator may preload the versioned
`socrates-sandbox` profile before the unprivileged engine starts. A candidate
still passes only when it accepts that profile explicitly, the workload reports
that exact label, and an otherwise writable probe path is denied by the
profile. A non-empty label alone is insufficient. The production host must
load the reviewed profile during trusted provisioning; the runner process
never receives profile-loading authority.

A disposable, dedicated Ubuntu virtual machine is an acceptable reference-host
class when the workflow runs directly on that VM, not inside a job container,
and the harness observes its Linux kernel, systemd cgroup v2 delegation, user
namespaces, and host LSM directly. Desktop Linux VMs, WSL, Podman Machine, and
shared container jobs remain development-only. Hosted-runner latency is
contextual comparison evidence, not a production capacity commitment.

The Ubuntu reference workflow also provisions the digest-verified full nerdctl
v2.3.1 distribution and starts its containerd service rootless under the same
unprivileged operator. This candidate is retained because nerdctl explicitly
supports applying an existing AppArmor profile to rootless containers, while
the measured Docker and Podman rootless configurations do not. Downloaded
tooling is version- and SHA-256-pinned; an unavailable or non-conforming
containerd candidate remains recorded evidence rather than an implicit
fallback.

Ubuntu 24.04 restricts unprivileged user namespaces through AppArmor. Because
the pinned nerdctl distribution installs RootlessKit under `/usr/local/bin`,
trusted provisioning loads the upstream-recommended path-specific RootlessKit
bootstrap policy before starting rootless containerd. That narrow host policy
permits creation of the user namespace; it does not replace the separately
loaded `socrates-sandbox` workload policy or grant the runner policy-management
authority.

For nerdctl, Docker-compatible inspect output is not authoritative for controls
it cannot represent faithfully. The spike reads the containerd-native OCI spec
as a second view and uses it for effective capability sets,
`noNewPrivileges`, the AppArmor profile, namespaces, mounts, and resource
limits. A missing native field fails closed. Docker-compatible output remains
useful for lifecycle state and normalized cross-engine reporting; sent command
arguments alone never count as enforcement evidence.

#### ADR-041 decision amendment: select rootless containerd through nerdctl

The reviewed native session
`2026-07-31T03-45-02-824Z-8be04f01` selects rootless containerd through
nerdctl v2.3.1 as the Slice 2.5 OCI backend. It passed all eight preflight,
nine adversarial, hard-cancellation, nine cleanup, and thirty cached
run-and-remove measurements. Its workload ran under
`socrates-sandbox (enforce)`, and the profile-specific write probe was denied.

Rootless Docker 29.7.0 is rejected on this host class because its workload
remained `rootlesskit (unconfined)` and Docker does not report an engine LSM.
Rootless Podman 4.9.3 is rejected because its workload remained
`crun (unconfined)`; its compatibility inspect also did not prove the complete
capability drop. Lower Podman latency cannot override failed enforcement.

This decision selects the backend and provisioning contract, not the spike
implementation. Slice 2.5 must introduce a new typed adapter, re-run startup
self-checks, require the pinned engine family and preloaded profiles, inspect
the native OCI spec, and fail closed before accepting work. No Docker or Podman
fallback is permitted. The immutable decision evidence lives under
`spikes/oci-engine/evidence/native/2026-07-31T03-45-02-824Z-8be04f01`.

### ADR-042: The production OCI boundary is capability-gated and two-layered

Slice 2.5 introduces a new `NerdctlSandboxBackend` in
`services/runner-local`; it does not promote or import the spike harness. The
backend owns typed, argument-array-only nerdctl invocations, startup
attestation, container identity, native OCI-spec verification, bounded
termination, and label-scoped cleanup. A higher `Runner` lifecycle adapter
may translate a `RunnerExecutionV1` into events only after the source and image
inputs described below exist. Until then, the package continues to export no
enabled production `Runner`.

The repository's no-host-execution audit remains in force everywhere except
the exact OCI process-boundary module. That module may import only
`spawn` from `node:child_process`, must set `shell: false`, and accepts only
the fixed nerdctl executable plus typed argument arrays from the backend. The
audit rejects another process import anywhere in the execution plane as well
as every process import in control-plane and UI packages. This exception is
authority to control the selected sandbox engine, not to run experiment
commands on the host.

Readiness is an explicit fail-closed state, not a best-effort check performed
after accepting work. Trusted host provisioning installs nerdctl v2.3.x,
starts rootless containerd, and loads the reviewed RootlessKit and
`socrates-sandbox` AppArmor policies. The unprivileged runner verifies Linux,
its non-root identity, rootless containerd, cgroup v2 delegation for CPU,
memory, and PIDs, seccomp, AppArmor, the expected nerdctl major/minor family,
and native OCI inspection support. It cannot install software, start a
rootful daemon, load policy, pull an image, or fall back to Docker or Podman.
A failed or stale attestation makes the backend unavailable and every
execution request fails before container creation.

The unprivileged runner is not assumed to have permission to enumerate the
kernel's complete AppArmor profile set. Host discovery therefore proves that
AppArmor is enabled, then the backend performs a deep attestation with the
admitted image before starting task work: it creates the fixed sandbox,
verifies its native OCI spec, starts a fixed no-shell probe, requires the exact
`socrates-sandbox (enforce)` process label, and requires the profile-specific
write denial. That proof is cached only for the same admitted image, resource
profile, engine readiness interval, and runner process. Failure invalidates
readiness and prevents the task sandbox from starting.

Rootless containerd places the runtime inside RootlessKit's user namespace, so
an additional OCI `linux.namespaces[type=user]` entry is not required and was
absent on the selected host. The deep probe instead reads its effective
`/proc/self/uid_map`; an identity mapping or host-root mapping fails readiness.
Private mount, PID, IPC, cgroup, and network namespaces remain mandatory in the
native OCI spec.

nerdctl serializes `--cap-drop ALL` as an explicit empty native
`Capabilities: {}` object rather than five empty arrays. The verifier admits
only that exact empty representation or all five named sets as explicit empty
arrays. Absence of the capabilities object, an unknown key, or any non-empty
set fails. The deep probe independently requires the live process's
`CapInh`, `CapPrm`, `CapEff`, `CapBnd`, and `CapAmb` values from
`/proc/self/status` to be all zero.

Every sandbox has a runner-derived opaque execution key and exact ownership
labels containing runner, task, attempt, and fence identity digests. Container
names never contain raw protocol identifiers. Creation uses the digest-pinned
image with pulls disabled, an empty inherited environment plus the fixed
`SOCRATES_SANDBOX=1` marker, disabled networking, read-only rootfs, non-root
UID/GID, private namespaces, no devices, all capabilities dropped,
no-new-privileges, the preloaded AppArmor profile, bounded tmpfs, memory, CPU,
PIDs, and no daemon log storage. Task budgets are capped by trusted runner
maximums; unsupported or unrepresentable limits fail before creation rather
than being rounded into weaker policy.

An admitted image may contribute environment defaults because they are part of
its immutable digest; host process variables are never forwarded. Inspection
requires the Socrates marker, unique variable names, and the absence of
deployment, CI, credential, runtime-socket, and provider-secret names. A later
image catalog records the exact admitted image environment. The backend also
replaces nerdctl's default shared-memory bind with an explicit bounded tmpfs.
The only non-source bind mounts it may admit are containerd-generated,
per-container `/etc/hosts`, `/etc/hostname`, and `/etc/resolv.conf` metadata
whose source is inside the unprivileged nerdctl runtime state. System `/etc`,
arbitrary home paths, and every other bind source fail inspection.

Sent arguments are intent, not enforcement evidence. The backend creates the
container without starting user work, reads `nerdctl inspect --mode native`,
and verifies the runtime-facing OCI spec against the exact requested profile.
Only then may the sandbox start. Inspection failure, timeout, cancellation,
or any mismatch triggers idempotent removal and produces no successful
workspace event. Network allowlists, accelerators, credentials, arbitrary
bind mounts, host namespace sharing, and privileged execution remain
unsupported capabilities in this slice.

An immutable snapshot digest is not a filesystem capability. A future
`SourceSnapshotMaterializer` must verify content digest and size, reject
links, devices, absolute paths, traversal, duplicate entries, and extraction
outside a runner-owned attempt directory, and return an opaque
attempt-scoped capability. Only the backend may resolve that capability into
the single read-only source bind allowed by ADR-041. Protocol fields and
caller strings are never joined to host paths.

Likewise, an image digest is identity but not admission. A future
`SandboxImageCatalog` must return an opaque capability proving that the
already-present digest is approved for the task architecture and implements
the versioned Socrates task-runtime ABI. That in-image runtime prepares the
bounded `/workspace` tmpfs from the read-only source, executes every declared
command with `shell: false`, frames untrusted stdout and stderr into bounded
data records, and emits one measurement result. The outer adapter remains
authoritative for time, resource, cancellation, framing, event identity, and
cleanup. Image metadata or output cannot self-authorize an image.

Cancellation addresses only the exact active attempt and fence. The backend
records its owned container before start, requests a graceful stop for at most
the accepted grace period, then hard-kills and removes it. A newer fence can
never be targeted by an older cancellation. Startup recovery enumerates only
containers carrying both the deployment ownership label and this runner's
identity label, verifies their full label set, and removes abandoned objects;
it never performs an unscoped engine prune.

The first native end-to-end test exercises readiness, create-before-start
native inspection, bounded execution, forced cancellation, and orphan cleanup
on the same provisioned Ubuntu host class as ADR-041. Unit tests use an
injected process boundary and assert exact argv, parsing, timeout, and cleanup
semantics without requiring Linux. The native test is explicit and gated; it
does not make ordinary workspace tests depend on an installed container
engine. An authenticated runner transport, lease polling, heartbeat loop,
durable event spool, source materializer, image catalog, task-runtime ABI,
artifact upload, and autonomous research loop remain later slices.

#### ADR-042 validation amendment: guarded backend admitted

GitHub Actions run `30604679736` on the provisioned Ubuntu 24.04 reference-host
class admits the Slice 2.5 backend. Rootless nerdctl/containerd v2.3.1 passed
startup readiness, the in-sandbox AppArmor/UID-map/live-capability probe,
create-before-start native inspection, bounded execution, exact-fence forced
cancellation, and post-run cleanup. The successful sandbox completed in
`238.05 ms`; cancellation and removal completed in `1223.42 ms`. These timings
are validation context, not capacity commitments.

The immutable result is stored at
`services/runner-local/evidence/native/30604679736.json`. This amendment admits
the low-level OCI backend only. `LocalRunnerNotEnabledError` remains correct
until the source materializer, image catalog/task-runtime ABI, lifecycle event
adapter, durable spool, and authenticated outbound transport land in their
planned slices.

### ADR-043: Source snapshots cross two pathless, attempt-scoped capabilities

An artifact identity is neither permission to read bytes nor permission to
mount a host directory. Slice 2.6 separates those authorities. The
content-addressed `ArtifactStore` may issue a process-local `VerifiedArtifact`
capability after digest and size verification. Its read port accepts only that
capability and returns a one-shot byte stream; it never returns an object path,
file descriptor, URL, or caller-selected filesystem location.

`SourceSnapshotMaterializer` consumes that stream for one exact runner, task,
attempt, and lease fence. While parsing it independently recomputes the archive
SHA-256 digest, counts the exact archive bytes, and enforces trusted limits for
entry count, path depth and length, individual file size, and total expanded
bytes. A previously verified object that changes before or during reading is
rejected. Task protocol fields cannot mint either capability.

The first source-snapshot media type is an uncompressed POSIX tar stream.
Compression is deliberately unsupported so decompression ratios cannot bypass
the artifact and expanded-byte budgets. `tar-stream` is used only as a
streaming record parser; it has no filesystem authority. The materializer, not
the parser, validates and writes every entry. It accepts only regular files and
directories. Links, devices, FIFOs, sparse files, unknown entry kinds, absolute
or drive-qualified names, traversal, backslashes, control characters,
non-normalized Unicode, duplicate or case-fold-colliding paths, non-portable
components, and file/directory ancestor conflicts fail the whole operation.
Archive ownership and timestamps are ignored. Only the executable bit is
retained; set-ID and sticky bits are forbidden.

Materialization occurs beneath one configured, runner-owned root. The
materializer creates a new private staging directory, opens regular files with
exclusive and no-follow semantics, verifies every parent remains a real
directory, and atomically publishes only after the entire stream and archive
identity pass. Failure removes only the exact staging directory created by
that invocation. Startup recovery enumerates only strictly named directories
inside this root and deletes an object only after its private manifest proves
the deployment, runner, attempt, fence, and digest ownership tuple.

Success returns a frozen, process-local `MaterializedSourceSnapshot`
capability. Public fields contain identity and bounded accounting only; no host
path is exposed. Only the local OCI package can resolve the capability through
an unexported `WeakMap` into the one source bind:

```text
verified artifact stream
  -> guarded tar parser
  -> private attempt directory
  -> opaque materialized capability
  -> /socrates/source (recursive read-only, private propagation)
```

The OCI builder accepts no raw source path. Native-spec verification requires
the exact resolved directory, destination, recursive read-only state, and
private propagation in addition to the existing sandbox policy. Nerdctl's
supported bind surface does not expose portable `noexec`, `nosuid`, or `nodev`
keys, so this ADR does not pretend to request them. Instead the archive
admission boundary makes device nodes and links unrepresentable, forbids
set-ID bits, and publishes an immutable tree. The in-image task runtime will
later copy that tree into bounded `/workspace`; it will never modify the host
staging tree. Materialization ownership must match the sandbox attempt
identity, and release is idempotent.

This ADR does not define source upload, snapshot resolution from durable
metadata, an admitted image catalog, task-runtime ABI, command execution, or
runner transport. Slice 2.6 tests the artifact read authority, adversarial tar
policy, scoped recovery and OCI mount attestation; `LocalRunnerNotEnabledError`
remains correct afterward.

#### ADR-043 validation amendment: source materializer admitted

GitHub Actions run `30605900587` on the provisioned Ubuntu 24.04 reference-host
class admits Slice 2.6. Rootless nerdctl/containerd v2.3.1 materialized a
verified 2,048-byte tar into an 18-byte nested source tree, bound it through the
opaque same-attempt capability, and passed create-before-start native OCI
inspection. The sandbox read the expected nested content, a write attempt
failed on the recursive read-only mount, and exact release left only the
runner-owned root marker. The successful sandbox completed in `224.07 ms`;
exact-fence cancellation and cleanup completed in `1209.65 ms`.

The immutable result is stored at
`services/runner-local/evidence/native/30605900587.json`. This amendment admits
only the pathless artifact read boundary, source archive materializer, opaque
capability, and guarded source bind. Durable snapshot resolution, the image
catalog/task-runtime ABI, lifecycle adapter, spool, transport, and autonomous
research loop remain later slices.

### ADR-044: Image admission is a trusted catalog decision with a probed ABI

An OCI digest proves content identity; image labels, configuration, and
process output remain claims made by that content. Slice 2.7 introduces a
`SandboxImageCatalog` whose trusted configuration pins the platform-specific
manifest content address, Linux architecture,
`socrates.task-runtime.v1` ABI revision, runtime entrypoint, and build identity.
The initial catalog is deployment configuration readable only by the runner.
A later signed control-plane distribution mechanism may replace that source,
but an image can never add itself to the catalog.

Admission is pathless and pull-free. For an exact task digest and architecture,
the catalog requires a matching trusted entry, proves the content already
exists in rootless containerd, and inspects its OCI manifest and configuration.
The observed platform, resolved manifest digest, rootfs configuration, fixed
runtime entrypoint, and ABI metadata must match the catalog. Mutable tags,
implicit platform selection, unrecognized media types, missing content,
volumes, healthcheck side effects, credential-like environment names, and
configuration drift fail before container creation. OCI configuration is
content-addressed evidence, not the authorization source.

The engine locator is the bare manifest content address (`sha256:<64 hex>`),
not a mutable tag or a registry-qualified digest reference. Reference-host
validation showed that nerdctl 2.3.1 resolves a locally created
`repository@digest` as a registry lookup even when containerd holds an image
metadata alias with that exact spelling. The bare address resolves only the
already-present local manifest and, with pulls disabled, cannot cross a
registry boundary. Native inspection must resolve that address to the same
manifest digest; the image name reported by containerd is audit context only
and cannot become identity or authority. The admitted opaque capability carries
the verified local content address, configuration digest, and the observed
local name. Creation still uses only the bare digest with pulls disabled;
post-create inspection may accept the observed name solely as an exact audit
continuity check because nerdctl stores that name, rather than the requested
bare address, in container metadata. This preserves the stronger property that
tag mutation between admission and creation cannot change executed bytes.

The catalog then executes a bounded handshake under the same guarded sandbox
profile used for work. The fixed runtime entrypoint must emit one strictly
parsed handshake frame containing the ABI revision and build identity pinned by
the catalog. No other stdout, stderr, filesystem marker, label, or exit code can
upgrade an untrusted image. Successful admission returns a frozen,
process-local `AdmittedSandboxImage` capability. Only the catalog issues it;
task protocol fields and structural lookalikes fail the OCI backend's runtime
capability check.

The runtime build identity is embedded, not accepted through argv or the
environment. Its deterministic two-pass bundle build first produces bytes with
a fixed digest placeholder, hashes those bytes, then rebuilds with that digest
embedded and writes the same value to a build manifest used by image assembly.
This is a reproducible ABI build cross-check, not image authorization: the
catalog must still pin and verify the OCI manifest and configuration digests.

`socrates.task-runtime.v1` is the only executable entrypoint for task work. The
outer runner does not place a declared command directly in nerdctl argv. It
creates the container without a terminal, starts the fixed runtime, and supplies
one bounded, length-prefixed canonical JSON request. The
request carries the exact fenced attempt identity, ordered action commands,
measurement command and protocol, fixed source destination, and already-capped
budgets. Attempt identity and image digest are compared again before input is
materialized. Request data is never stored in image metadata, environment, or
a caller-selected host bind.

The four-byte length prefix is the request terminator; transport EOF is not
part of the ABI. The guarded runner owns this boundary: it validates and
encodes the entire canonical request before create and exposes exactly one
complete buffer. The runtime rejects any coalesced second frame or trailing
bytes before work begins.

Native validation established that nerdctl does not forward stdin through
`start --attach`, while its documented attach implementation cannot attach to a
container started without `--attach`. The create-before-start inspection gate
therefore makes stdin unavailable in the admitted CLI backend. The guarded
runner materializes the validated frame behind an opaque, attempt-scoped
capability, mounts only that owned file recursively read-only at the fixed
`/socrates/request.bin` ABI path, and removes it after every terminal path. The
path cannot be supplied by a caller, and native OCI inspection checks the exact
owned source and destination before start. The runtime reads the bounded file
once and remains inert until the complete frame is available.

For every guarded container invocation, the backend maps the authorized outer
command executable to nerdctl's explicit `--entrypoint` option and places only
its argument array after the image content address. Image configuration therefore
cannot prepend a second executable or reinterpret handshake/profile/runtime
arguments. Task-declared commands remain exclusively inside the framed runtime
request.

The runtime copies `/socrates/source` into the bounded `/workspace` tmpfs,
retaining the Slice 2.7 no-exec workspace policy, and invokes each absolute
executable with an argument array, `shell: false`, an exact workspace working
directory, and a minimal fixed environment. ABI v1 supports image-baked tools;
workspace executables, implicit shells, network allowlists, credentials, and
package installation remain unsupported capabilities. Runtime timeouts are
defense in depth; the outer backend remains authoritative for wall time,
cgroups, cancellation, output bytes, and cleanup.

Child stdout and stderr never share the runtime control channel verbatim. The
runtime converts them into bounded binary-safe frames carrying command index,
stream, sequence, and base64 payload. It emits explicit command-start,
command-exit, measurement-result, runtime-error, and completion frames.
Measurement results use the same bounded payload size as command output and
carry an independent zero-based sequence plus an explicit final marker; this
keeps the 1 MiB request-level result budget compatible with the small fixed
frame maximum without allowing an oversized control message. At least one
result frame is required, including for an empty result. Frames use a four-byte
big-endian length followed by strict UTF-8 JSON and reject unknown fields,
sequence gaps, trailing bytes, or output after completion. Measurement bytes
remain untrusted data and are validated by the outer lifecycle adapter in
Slice 2.8.

Child write fragmentation cannot amplify frame count independently of the byte
budget. The runtime retains each command's already-bounded stdout and stderr in
memory until that command exits, then emits deterministic stream chunks of at
most 48 KiB before the exit frame. The outer backend independently caps the
attached process output and frame stream.

Slice 2.7 admits the catalog capability, runtime protocol implementation, and
native handshake/execution proof. It does not enable task leasing, translate
frames into runner events, persist a spool, acknowledge events, or connect a
runner transport. `LocalRunnerNotEnabledError` remains correct until those
Slice 2.8 and 2.9 responsibilities land.

Validation amendment, 2026-07-31: GitHub Actions reference-host run
`30641068455` at commit `64ffe11` passed the rootless containerd readiness,
guarded production backend, admitted image catalog and live handshake, exact
read-only request artifact, fixed runtime entrypoint, source-copy and
read-only-source proof, workspace write, framed measurement, exact-fence
cancellation, release, recovery, and zero-residual-container gates. The
successful execution completed in 535.31 ms with seven valid frames. Immutable
evidence is committed at
`services/runner-local/evidence/native/30641068455-runtime.json`. This amendment
admits ADR-044 and closes Slice 2.7; lifecycle event translation remains Slice
2.8.

### ADR-045: Runtime evidence becomes validated event drafts before durability

Slice 2.8 introduces a pure lifecycle adapter between the admitted runtime
result and the durable runner event spool. It does not create a production
`Runner`, claim work, send acknowledgements, or assign event envelopes. The
adapter accepts one already-validated `RunnerExecutionV1`, the admitted image
and source identities, and one closed runtime frame sequence. It returns a
bounded ordered list of internal event drafts whose payloads are validated
against the corresponding `RunnerEventV2` payload schemas.

The adapter emits `workspace.prepared` immediately before the first command
draft, which proves the runtime completed source copying; a pre-command source
or request failure cannot claim a prepared workspace. Action-phase start and
exit frames become `action.started` and, when an exit code exists,
`action.completed`.
Signal-only exits proceed directly to a terminal failure because V2 does not
invent a portable numeric exit code. Action stdout and stderr become inert
`log.appended` drafts. Measurement stderr may also become a log; measurement
stdout is not logged because the runtime already repeats those exact bounded
bytes through `measurement.result` frames. This avoids duplicate evidence and
quota consumption.

Runtime command durations are already non-negative integers. The outer sandbox
duration may retain sub-millisecond precision, so terminal event duration uses
the ceiling in milliseconds; evidence accounting never understates elapsed
time to satisfy an integer transport field.

Command-output bytes are accumulated only within the existing runtime output
budget, decoded as a continuous UTF-8 stream so code points split across frames
remain intact, and passed through a deterministic local secret redactor before
event chunking. Invalid byte sequences become replacement characters and mark
the draft redacted. Chunks are split by Unicode code point so both the 16,384
character and 65,536 UTF-8 byte contract limits hold. The control plane retains
its independent secondary redactor; runner provenance is never treated as
proof.

The deterministic credential patterns live in an execution-neutral
`@socrates/evidence-policy` package used by both the local adapter and database
ingestion. Centralizing only the pure text policy prevents runner and control
plane rules from drifting without creating a dependency from the control plane
to runner code. Each boundary still invokes the policy independently and
recomputes its own UTF-8 accounting.

The complete measurement result is decoded with fatal UTF-8, parsed as strict
JSON with exactly `schema` and `value`, requires schema `metric-value.v1`, and
validates `value` as the canonical decimal contract. Metric definition and unit
come from the frozen task rather than runtime bytes, and ABI v1 records one
sample per measurement command. A valid successful terminal frame requires
exactly one measurement draft followed by `task.succeeded`.

Failure mapping is closed and based on structured runtime codes, never message
text: invalid request, source-copy, and internal failures are infrastructure;
action command failures are invalid action; measurement failures are
evaluation; command timeout is a wall-time budget failure; and the structured
`output_budget_exceeded` code is a log-byte budget failure regardless of
command phase. Runtime message text is never parsed to recover missing
structure. A malformed
measurement or contradiction between runtime status and frames is a local
protocol error and cannot produce a success event. Slice 2.8 adds adversarial
tests for every mapping before any code may enable execution.

The adapter deliberately does not assign `eventId`, sequence, or `occurredAt`.
Those values must be allocated together with durable bytes by the Slice 2.9
spool; assigning wall-clock timestamps before persistence would make restart
replay change the normalized event digest. The spool will turn drafts into full
V2 envelopes atomically and discard them only after the control plane
acknowledges their exact IDs. `LocalRunnerNotEnabledError` therefore remains in
force through Slice 2.8.

Validation amendment, 2026-07-31: the pure adapter is admitted. The repository
quality gates passed across all 13 workspaces: formatting, TypeScript,
ESLint, unit/property/adversarial tests, Phase 1 and Phase 2 dependency audits,
production builds, and a low-severity dependency audit with no known
vulnerabilities. The runner-local suite passed 124 tests with three explicitly
environment-gated integration tests skipped; task-runtime passed 20 tests with
one platform-gated test skipped; the new shared evidence policy passed its two
tests. `LocalRunnerNotEnabledError` remains unchanged. This closes Slice 2.8;
durable envelope allocation, replay, and acknowledgement remain Slice 2.9.

### ADR-046: The local event spool commits closed batches before delivery

Slice 2.9 introduces a private, file-backed event spool inside
`services/runner-local`. The spool is the first owner of complete
`RunnerEventV2` envelopes. It accepts an admitted `RunnerExecutionV1` identity
and one closed lifecycle-draft batch, allocates the positive attempt-local
sequences, UUID event IDs, and one immutable RFC 3339 occurrence timestamp,
validates every completed envelope, then durably commits the whole batch before
returning it to a sender. It has no control-plane client and does not enable the
production runner.

The acknowledgement wire shape becomes a versioned contract in
`@socrates/contracts`, not a runner import from `@socrates/database`. Version 1
contains the event ID, attempt ID, acknowledged sequence, expected next
sequence, and an RFC 3339 control-plane receive timestamp. The database may use
`Date` internally, but the API transport must explicitly serialize that value;
the spool accepts only the validated wire contract.

The first implementation uses only stable Node filesystem primitives rather
than a native SQLite dependency. This keeps the local runner artifact portable
and auditable, while making the durability protocol explicit. Node documents
that promise-based filesystem mutations are not synchronized, so every attempt
is serialized by the spool and the deployment contract permits only one runner
process to own a configured spool root. Multi-process ownership requires a
future store adapter with an operating-system lock or transactional database;
it is not inferred from an in-memory mutex.

The configured root is trusted bootstrap state, is dedicated to Socrates, and
is private to the runner account. Attempt paths are derived only from a SHA-256
digest of the validated runner, task, attempt, and fence identity. Protocol
values are never joined directly into host paths. Directories use mode `0700`
and records use `0600` on the native Linux host. Symlinks, unexpected file
types, unknown files, incompatible versions, non-canonical JSON, broken
checksums, duplicate or gapped segments, invalid envelopes, and identity
mismatches make that attempt unreadable; recovery never guesses or silently
truncates evidence.

Each attempt has an immutable manifest, one immutable segment, one immutable
commit marker, and a mutable acknowledgement record. The manifest binds
the complete canonical execution digest to the attempt key. A segment contains
one or more contiguous full envelopes, its inclusive sequence range, and a
SHA-256 checksum over its canonical contents. A closed lifecycle result is one
segment, so a crash exposes either the complete event batch or no batch; it
cannot leave a durable prefix that would require unsafe experiment re-execution
to reconstruct the missing suffix. Slice 2.9 admits exactly one segment per
attempt and requires its final draft to be exactly one terminal event. Later
incremental event producers require a new idempotency key and architecture
revision; they cannot reuse this batch API implicitly.

The segment is published before `commit.json`. The commit marker binds the
segment name, checksum, range, and terminal event ID. Restart repairs the valid
segment-present/marker-absent state by publishing the derivable marker before
replay. A marker without its segment is corruption unless the exact terminal
event is durably acknowledged, in which case it proves intentional post-ack
cleanup. Append does not report success until both records are durable. This
distinguishes a never-committed attempt from evidence that disappeared after a
successful commit.

Immutable publication writes canonical bytes to a same-directory exclusive
temporary file, synchronizes it, creates the final directory entry with an
exclusive hard link, removes the temporary name, and synchronizes the parent
directory before reporting success. Unlike POSIX rename, link publication
cannot silently replace an existing final segment. Existing final names are
compared byte-for-byte and never overwritten. The mutable acknowledgement uses
same-directory temporary write, file sync, atomic rename, and directory sync.
Temporary files are ignored and removed only after their internally generated
name and containing attempt have been validated. Segment size, event count,
attempt count, and total spool bytes are bounded by trusted configuration;
capacity exhaustion fails before execution can treat evidence as durable.

The acknowledgement record stores the exact event ID, attempt ID, acknowledged
sequence, expected sequence, and control-plane receive time. It advances only
for the next pending event and only when every field agrees with the persisted
envelope and the control-plane acknowledgement contract. It is replaced with
the same write, sync, rename, directory-sync protocol. A crash before that
replacement merely replays an already committed event, which the control plane
acknowledges idempotently. A crash after it cannot resurrect an older event.
Duplicate acknowledgements are accepted only when they match the durable
record exactly; regression, jumps, or conflicting IDs fail closed.
The local acknowledgement wrapper also records a derived terminal tombstone;
this is not a wire field. It preserves the no-further-append invariant after a
fully acknowledged terminal segment is safely removed.

Pending iteration always starts after the durable acknowledgement cursor and
returns immutable envelopes in strict sequence. A fully acknowledged segment
may be unlinked only after the acknowledgement record is durable and the
segment directory is synchronized. The attempt manifest and acknowledgement
tombstone remain; attempt retention and garbage collection are a later
reconciler concern. Terminal events prohibit later segment appends.

The spool never treats delivery as persistence, never acknowledges on HTTP
request completion alone, and never derives identity from timestamps. Fault
injection covers every write, sync, rename, acknowledgement, cleanup, and
restart boundary. Native Linux validation must additionally prove permission
modes and directory synchronization. `LocalRunnerNotEnabledError` remains in
force through Slice 2.9; transport, heartbeat coordination, cancellation
delivery, and the executable runner service are later slices.

Validation amendment, 2026-07-31: GitHub Actions run `30644887440` passed the
complete Ubuntu quality pipeline, including isolated PostgreSQL integration
suites, the browser journey, production builds, and the native spool probe on
Node v22.23.1 as uid 1001. The probe admitted directory synchronization,
private `0700` directories, private `0600` segment and commit records,
single-link immutable publication, byte-identical restart replay, monotonic
acknowledgement, terminal cleanup, and rejection of a missing committed
segment. Immutable evidence is committed at
`services/runner-local/evidence/native/1785513485110-bbef45b2-ef4d-4bdd-a8cf-7358b8622bb4-spool.json`.
Local full-workspace formatting, typecheck, lint, unit/adversarial tests,
dependency-boundary audits, production builds, and the low-severity dependency
audit also passed with no known vulnerabilities. This admits ADR-046 and closes
Slice 2.9. `LocalRunnerNotEnabledError` remains unchanged.

### ADR-047: Runner HTTP transport derives identity from a revocable principal

Slice 2.10 introduces the first public runner transport, but it does not turn
the local runner into a production execution service. The Hono API exposes a
small outbound-only HTTP boundary for a runner that already knows a durable
task ID: claim that exact task, renew its exact attempt lease while observing a
cancellation directive, and submit one already-spooled event for a durable
acknowledgement. The runner-side adapter is a typed client for those operations.
It does not start the OCI engine, discover tasks, own a heartbeat loop, or
delete spool evidence without an exact acknowledgement.

The transport is disabled unless both persistence and a runner-authenticator
port are configured. Every route authenticates before parsing or invoking an
application command. Authentication returns a typed principal containing the
token ID, runner ID, and workspace ID. Route handlers inject that runner ID;
claim and heartbeat bodies do not contain one. Event envelopes necessarily
carry their immutable runner ID, so the handler compares it with the principal
before ingestion. A caller-supplied ID can never select another registration.
Unknown, malformed, expired, or revoked credentials share one unauthorized
response and no authentication response reveals whether a runner or token
exists.

The initial deployment authenticator uses a manually provisioned opaque bearer
credential with a public UUID selector and a 256-bit random secret. PostgreSQL
stores the selector, runner binding, SHA-256 secret digest, creation/expiry,
and revocation facts, never the raw credential. A uniformly random 256-bit
secret retains its security against offline guessing when represented by a
fast digest; verification still decodes fixed-length bytes and uses a
constant-time comparison. Multiple token rows permit overlap during rotation.
Registration status remains an independent scheduler authorization check, so
a valid credential cannot revive a draining or offline runner. Token creation
is an operator-only utility, not a public API route, and reveals the raw secret
exactly once.

Credential lookup is a dedicated persistence port beside workspace reads, not
part of `TransactionRepositories`. Authentication happens before a runner
command transaction and must not enlarge the scheduler's domain transaction
surface. The port may return a fixed-size digest and usability bit only to the
authenticator; provisioning owns its own short database transaction and
operator utility.

Opaque-token parsing, generation, hashing, constant-time verification, and the
authenticator port live in execution-neutral `@socrates/runner-auth`. That
package depends only on shared contracts and an injected credential lookup; it
cannot import Hono, PostgreSQL, the API application, or runner execution code.
This keeps the one-time provisioning utility and request authenticator on one
cryptographic implementation without making database code own HTTP identity.

Runner routes are versioned JSON under `/v1/runner`:

- `POST /tasks/:taskId/claims` accepts a client-generated attempt UUID and a
  bounded requested lease duration. Repeating the same task/attempt identity
  is the existing exact claim replay; a lost response never requires a new
  identity.
- `POST /tasks/:taskId/attempts/:attemptId/heartbeat` accepts the fence and a
  bounded requested lease duration. A renewed response carries the
  database-clocked expiry and a closed `continue` or `cancel` directive derived
  from the task state in the same transaction.
- `POST /events` accepts exactly one complete `RunnerEventV2`. Success returns
  the versioned wire acknowledgement from ADR-046 plus whether ingestion was
  an exact replay.

Task discovery is deliberately not inferred from this API. ADR-031 already
makes the transactional outbox the durable delivery boundary; a later
dispatcher/task-source slice may deliver task IDs at least once and may choose
polling, streaming, or a broker without changing claim semantics. Scanning an
arbitrary JSON capability queue inside a convenient `claim-next` endpoint
would create an unbounded scheduler policy and bypass the unpublished outbox
contract. Slice 2.10 therefore accepts task IDs only from an injected future
task-source port or direct transport tests.

All request and response bodies use strict shared Zod contracts, RFC 3339
strings at the wire, JSON media types, and explicit byte ceilings. The API does
not rely on `Content-Length` alone and rejects oversized streamed bodies. The
client likewise bounds response bytes before JSON parsing, rejects redirects,
validates media type and schema, and never includes bearer credentials in an
error. Hono's generic bearer middleware supports asynchronous token checks,
but Socrates uses a dedicated typed middleware because downstream handlers
need the authenticated principal, not a boolean. Authentication, domain
errors, and protocol errors retain the existing API error envelope.

The Node client uses the stable built-in `fetch` boundary behind an injected
port and composes caller cancellation with an operation timeout. HTTPS is the
default and required for deployed credentials. Plain HTTP requires an explicit
development/test option; it is never enabled because an address is loopback.
Transport primitives make one network attempt and classify timeout,
connection ambiguity, authentication, protocol, conflict, and server failure.
The future coordinator owns backoff and may retry only with the same durable
identity: the same claim attempt UUID, heartbeat fence, or exact spooled event.
This prevents hidden retries from extending leases or changing evidence
identity outside coordinator policy.

Each operation accepts only HTTP 200 with an `application/json` media type and
its exact success schema. Redirect following is disabled so credentials cannot
cross an origin through a control-plane response. Non-success responses may
contribute only a validated API code and request ID to a typed transport error;
raw response bytes, details, URLs containing credentials, and authorization
headers are never retained.

The event sender reads the first pending spool envelope, submits only that
envelope, validates the exact acknowledgement, then delegates advancement to
the spool. It never pipelines attempt sequences and never treats an HTTP 2xx
status alone as acknowledgement. A gap response is actionable only when its
expected sequence agrees with local durable state; conflicting control-plane
state fails closed. Authentication material belongs to the transport process
and is never copied into a task, source workspace, sandbox environment, log,
artifact, or diagnostic snapshot.

Primary implementation references are Hono's official bearer/custom
middleware documentation and Node's official global `fetch`,
`AbortSignal.timeout`, and `AbortSignal.any` documentation:

- <https://hono.dev/docs/middleware/builtin/bearer-auth>
- <https://hono.dev/docs/guides/middleware>
- <https://nodejs.org/api/globals.html>

`LocalRunnerNotEnabledError` remains the production entry-point behavior after
Slice 2.10. Enabling task discovery, the lease coordinator, OCI execution,
restart reconciliation, and automatic cancellation is a later architecture
decision with native end-to-end evidence.

Validation amendment, 2026-07-31: GitHub Actions run `30647374933` passed the
complete Ubuntu quality pipeline for commit `b20a657`. Schema compatibility 6
and the revocable credential migration applied successfully. All six database
integration files, all nine API integration files, all twenty-two runner-local
test files, the native spool durability probe, the Chromium product journey,
and every production build passed. The authenticated PostgreSQL journey proved
missing-credential rejection, principal-bound exact claim, database-clocked
heartbeat, durable cancellation observation, terminal event acknowledgement,
and exact terminal replay. Runner-local passed 159 local tests and all 162
tests in CI; its filesystem-backed sender tests prove ambiguous network failure
preserves byte-identical pending evidence and acknowledgement mismatch cannot
advance the spool. Local formatting, typecheck, lint, unit/adversarial tests,
Phase 1 and Phase 2 dependency audits, production builds, and the low-severity
dependency audit passed with no known vulnerabilities. This admits ADR-047 and
closes Slice 2.10. `LocalRunnerNotEnabledError` remains unchanged.

### ADR-048: Task delivery identity is durable before the first claim

Slice 2.11 closes the runner restart window between receiving a task delivery
and durably learning its fenced execution snapshot. A new private work journal
admits a versioned delivery containing a delivery UUID and task UUID, allocates
one attempt UUID, and commits those three identities before any claim request.
Every reconciliation of that delivery uses the same task and attempt IDs. A
network failure or crash before the claim response therefore cannot create a
second logical attempt.

The journal does not discover work. A future `TaskSource` may derive delivery
IDs from PostgreSQL outbox messages, a broker, polling, or a cloud queue, but it
must hand one validated delivery to this boundary. The source may acknowledge
its own delivery only after the journal admission is durable. Slice 2.11 uses
an injected source in tests and does not read, publish, or mutate
`outbox_messages`; choosing dispatcher concurrency, capability routing, and
redelivery policy remains a separate architecture decision.

Each delivery becomes a hashed directory beneath a dedicated private journal
root. An immutable canonical manifest binds format version, delivery ID, task
ID, generated attempt ID, and admission timestamp. A later immutable claim
record binds that manifest to the complete validated `RunnerExecutionV1`, its
canonical digest, and the journal commit timestamp. The execution must repeat
the manifest task/attempt identities; its runner identity comes only from the
authenticated claim response. A committed claim record is the sole execution
snapshot returned downstream.

Admission and claim publication reuse execution-neutral private-filesystem
primitives extracted from the event spool: exclusive temporary creation,
file sync, create-if-absent hard-link publication, temporary unlink, directory
sync, private modes, owner checks, symlink rejection, and canonical byte
comparison. Spool-specific manifests, segments, acknowledgement logic, and
event semantics remain in `spool`. The extraction must first preserve every
existing spool fault-injection and native Linux gate; shared durability code is
not permission to couple journal and event state.

The journal permits one owning process per configured root, serializes all
operations within that process, hashes protocol identities before forming
paths, and enforces maximum item count, record bytes, and root bytes. Unknown
files, noncanonical JSON, version drift, identity mismatch, checksum mismatch,
hard-link count drift, invalid permissions, and incompatible duplicate
delivery IDs fail closed. Re-admitting the same delivery/task returns the
original attempt ID. Reusing a delivery ID for another task is an identity
conflict and never overwrites the manifest.

An item directory created immediately before a process crash may contain no
record. That exact empty hashed-directory state is recoverable: startup counts
it toward capacity but exposes no diagnostic item, and a later admission for
the matching delivery may publish its first manifest. Any claim, unknown
entry, invalid temporary name, or malformed manifest in that directory remains
corruption. This distinguishes a proven pre-publication crash residue from an
identity or evidence rewrite without inventing a cleanup policy.

`ExactClaimReconciler` reads the durable manifest and invokes the Slice 2.10
client with that exact task and attempt identity. It makes one HTTP attempt per
call. A valid response is checked against the manifest and committed before it
is returned. A crash before claim-record publication repeats the same
idempotent control-plane claim; a crash after publication returns the stored
execution without network access. Transport errors and authoritative conflicts
leave the item pending. Slice 2.11 never guesses that a conflict is terminal,
never allocates a replacement attempt, and never mutates the server lease.

If downtime exceeds the lease and exact replay can no longer succeed, the
pending manifest remains diagnostic truth. A later lease/outbox reconciler may
observe the control-plane outcome and admit a genuinely new delivery only
after scheduler policy permits it. This slice does not add a status endpoint,
lease timer, retry loop, backoff, heartbeat, cancellation controller, executor,
or garbage collector merely to hide that unresolved state.

The journal stores no bearer credential, authorization header, base URL,
source path, sandbox environment, log, or artifact. Diagnostics expose only
delivery/task/attempt IDs, a closed `pending_claim` or `claimed` state, and
bounded timestamps. Claim records are retained until a future coordinator can
prove source acknowledgement, terminal spool acknowledgement, and sandbox
cleanup; age alone never deletes unresolved work.

`LocalRunnerNotEnabledError` remains the production entry-point behavior after
Slice 2.11. The slice proves exact restart reconciliation but does not start an
executable runner.

Validation amendment, 2026-07-31: implementation commit `06612fa` passed local
formatting, typecheck, lint, 178 runner-local tests, all workspace tests, Phase
1/2 boundary audits, production builds, and the low-severity dependency audit.
GitHub Actions run `30648879704` passed real PostgreSQL integration, the native
spool regression, the new native work-journal permission/restart probe, the
Chromium product journey, and production builds. The run uploaded separate
`runner-spool-native-evidence` and `runner-work-journal-native-evidence`
artifacts. Fault injection covers all six immutable publication boundaries for
both manifests and claims; restart exposes an empty recoverable item, one
complete manifest, or one complete claim and never a replacement durable
attempt. This evidence admits ADR-048 and closes Slice 2.11 while production
execution remains disabled.

### ADR-049: Task discovery uses fenced control-plane offers, not the outbox

Slice 2.12 connects authenticated runners to the proven work journal without
turning `outbox_messages` into a runner queue. The existing outbox records
domain publication intent and has no runner owner, reservation identity, or
claim fence. Directly polling it could expose one task to multiple runners,
causing each runner to durably allocate a different attempt before the
scheduler chooses a winner. `published_at` also cannot honestly mean both
external event publication and runner admission.

The control plane therefore owns a dedicated `runner_task_deliveries` table.
An authenticated acquire operation selects at most one queued, protocol-2,
workspace-local, capability-compatible task, locks candidate rows with
`FOR UPDATE SKIP LOCKED`, and inserts an immutable delivery UUID bound to the
task and authenticated runner. PostgreSQL documents `SKIP LOCKED` as an
inconsistent general-purpose view that is appropriate for avoiding contention
among consumers of a queue-like table; Socrates uses it only inside this
bounded reservation transaction, with deterministic `created_at, id` ordering
([PostgreSQL SELECT](https://www.postgresql.org/docs/18/sql-select.html)).

The delivery state is closed: `offered` or `claimed` in this slice. One partial
unique constraint permits at most one non-revoked delivery per task, while a
runner/delivery identity constraint makes acquire replay stable. Slice 2.12
does not implement revocation or expiry; an unresolved offer remains visible
to the same runner and unavailable to other runners. Reassignment requires a
later reconciler that can fence the old delivery before creating a new one.
Age alone is never proof that a runner did not durably journal an offer.

The authenticated API exposes one bounded, non-long-polling acquire request.
It returns either `200` with `RunnerTaskDeliveryV1` or `204` with no body. The
principal supplies runner/workspace identity; request JSON cannot choose a
runner, workspace, task, capability set, ordering cursor, or batch size. One
request performs one database transaction and no hidden retry. A later broker
or cloud queue may implement the same `TaskSource` contract without changing
the journal.

There is no separate delivery acknowledgement endpoint. After acquire, the
runner first calls `LocalWorkJournal.admit`. The exact claim request is then
scoped by delivery UUID and carries the journal's durable attempt UUID. In one
control-plane transaction the repository locks the delivery, verifies its
runner/task identity and `offered` state, invokes the existing scheduler claim
with that exact attempt, and marks the delivery `claimed` only when the lease
is created. Exact replay must return the same task, runner, attempt, and fence.
This avoids an intermediate “acknowledged but unclaimed” state and makes the
claim itself the durable source acknowledgement.

The legacy task-ID claim route remains available only as the already-tested
Slice 2.10 primitive while production execution is disabled; the new
journaled source path must use delivery-scoped claims. Enabling any production
runner later requires removing or explicitly policy-gating the bypass so every
discovered claim proves a delivery reservation.

Candidate scanning is bounded and fail-closed. The repository locks the active
runner registration, checks current capacity, loads a small deterministic
candidate window, and applies the same exact capability predicate used by
claim. Invalid JSON capability projections are skipped and reported through
diagnostics, never treated as permissive. Empty capacity or no compatible task
returns `none`; it does not expose why foreign or incompatible tasks exist.

`HttpTaskSource` and its journal adapter remain execution-plane libraries.
They store no credential, URL, or response body in the journal, perform one
network attempt, validate the exact delivery contract, durably admit before
handoff, and return immutable identity/state only. They add no polling timer,
backoff, heartbeat, execution, outbox mutation, cleanup, or process entry
point. `LocalRunnerNotEnabledError` remains unchanged after Slice 2.12.

Validation amendment, 2026-07-31: commits `c25f1f6` and `6193aab` passed local
formatting, typecheck, lint, all workspace tests, 181 runner-local tests, 56 API
tests, 40 contract tests, Phase 1/2 boundary audits, production builds, and the
low-severity dependency audit. GitHub Actions run `30650673400` applied schema
compatibility 7 and passed the isolated real-PostgreSQL two-runner acquire
race, stable offer replay, delivery/task/attempt conflict checks, atomic
delivery claim, unchanged outbox state, authenticated acquire-to-terminal
transport journey, native spool/journal probes, Chromium journey, and builds.
This admits ADR-049 and closes Slice 2.12. Offer expiry/reassignment and
production execution remain disabled.

### ADR-050: Expired unclaimed offers are explicitly revoked before reassignment

Slice 2.13 prevents an abandoned `offered` delivery from pinning a queued task
forever while preserving the durable-journal fence. Expiry is control-plane
state, not client authority. A trusted deployment option supplies a bounded
offer duration; the acquire transaction computes `expires_at` from PostgreSQL
`CURRENT_TIMESTAMP`. PostgreSQL defines that value as the transaction start
time, giving every statement in the transaction one stable time basis
([PostgreSQL date/time](https://www.postgresql.org/docs/current/datatype-datetime.html)).
Request bodies cannot choose or extend the duration.

Delivery state becomes `offered | claimed | revoked`. An offered row has no
attempt, fence, claimed timestamp, or revoked timestamp. A claimed row has the
complete attempt/fence/claimed identity and can never be revoked by this
protocol. A revoked row has no attempt/fence/claim identity and records a
revoked timestamp plus the closed reason `expired`. Database checks enforce
the three complete shapes; partial state is impossible.

A bounded repository reconciler selects expired offered rows in deterministic
`expires_at, id` order with `FOR UPDATE SKIP LOCKED`, then changes only those
locked rows to revoked. PostgreSQL explicitly supports ordered, limited update
batches and `SKIP LOCKED` to reduce contention between workers
([PostgreSQL UPDATE](https://www.postgresql.org/docs/18/sql-update.html)). The
slice exposes the repository/service boundary and deterministic tests but no
timer, cron process, daemon, or production runner loop.

Revocation and claim serialize on the same delivery row lock. If claim locks
first, the scheduler lease and `claimed` delivery commit together and the
reconciler observes a non-offered row. If revocation locks first, the stale
claim observes `revoked` and fails before invoking scheduler claim. There is no
state in which a revoked delivery creates a lease. The control plane may issue
a new delivery UUID only after the old row is durably revoked; the partial
unique active-task index then permits exactly one new owner.

Acquire replays only an unexpired offer. Expired but unreconciled offers are
not handed to the runner and continue to fence the task until explicit
reconciliation. After revocation, the same or another compatible runner may
acquire a new delivery ID. A runner retaining the old local manifest keeps
diagnostic truth, but its delivery-scoped claim receives an authoritative
conflict and cannot allocate a scheduler attempt. The local journal is never
rewritten or deleted automatically.

Slice 2.13 does not expire claimed deliveries; scheduler lease reconciliation
already owns that lifecycle. It does not retry, quarantine, delete, or compact
revoked rows, infer runner death, mutate the integration outbox, or enable
execution. `LocalRunnerNotEnabledError` remains the production entry point.

Validation amendment, 2026-07-31: implementation commits `9513f83` and
`97e7d0f` passed local formatting, TypeScript, ESLint, all workspace tests,
Phase 1/2 dependency-boundary audits, and production builds. GitHub Actions
run `30652305248` applied schema compatibility 8 and passed all 54 database
tests, including the offered-expiry index plan and real PostgreSQL proofs for
database-clocked expiry, expired-but-unreconciled fencing, stale-claim
rejection, new-delivery reassignment, claimed-delivery immunity, and two
concurrent reconcilers returning disjoint bounded batches. The authenticated
API and runner integration suites, native spool and work-journal durability
probes, Chromium product journey, and all production builds also passed. This
admits ADR-050 and closes Slice 2.13. Timers, cleanup, autonomous execution,
and production runner enablement remain absent.

### ADR-051: Work admission is restart-first and records authoritative rejection

Slice 2.14 composes the already-admitted task source, local work journal, and
delivery-scoped claim into one single-transition coordinator. Today each
primitive is safe in isolation, but a caller could acquire a new offer before
recovering an older `pending_claim` manifest after restart. The coordinator
must inspect durable local work first and may contact acquire only when no
locally actionable item exists. This ordering is a safety invariant rather
than a polling preference.

The work-journal state machine becomes closed and append-only:

```text
manifest(pending_claim) -> claim(claimed)
manifest(pending_claim) -> rejection(rejected: control_plane_conflict)
```

A claim and rejection are mutually exclusive terminal records for one
delivery key. An authenticated, contract-valid HTTP `409` from the exact
delivery claim is authoritative evidence that the durable attempt cannot own
that delivery; the coordinator commits a bounded rejection record before
returning the rejected result. Timeout, abort, network, authentication,
server, response-size, and protocol failures are not authoritative and leave
the manifest pending for an exact-identity retry. Rejection never deletes or
rewrites the manifest and never creates a replacement attempt.

One `prepareNext` call is serialized in-process and performs at most one
control-plane transition. It orders journal entries by `admittedAt`, then
delivery ID. A claimed item is returned byte-equivalently without acquire or
claim traffic. A pending item is reconciled with its stored attempt UUID. A
rejected item is retained for diagnostics but is not actionable. Only when no
pending or claimed item exists may the coordinator acquire one offer, durably
admit it, and attempt its exact claim. An idle acquire returns an explicit
idle result. There is no hidden loop or backoff.

Crash boundaries preserve monotonic truth: before manifest publication there
is no local work; after it, restart retries the same attempt identity; after a
claim response but before claim publication, exact server replay returns the
same lease; after an authoritative conflict but before rejection publication,
restart repeats the same harmless conflict; and after either terminal record,
restart performs no duplicate transition. Filesystem publication reuses the
private, no-overwrite, fsync-backed durability primitive admitted by ADR-046
and ADR-048.

Slice 2.14 adds no daemon, polling interval, retry delay, heartbeat,
cancellation monitor, execution handoff, event production, completion marker,
garbage collection, or automatic journal deletion. It does not enable the
runner entry point. `LocalRunnerNotEnabledError` remains the production
behavior until later slices admit lease supervision and end-to-end execution.

Validation amendment, 2026-07-31: implementation commit `13b0d4a` passed
local formatting, TypeScript, ESLint, 194 runner-local tests, all workspace
tests, Phase 1/2 dependency-boundary audits, production builds, and the
low-severity dependency audit with no known vulnerabilities. GitHub Actions
run `30653250463` passed every PostgreSQL and API integration, the Chromium
product journey, production builds, and both Linux native durability probes.
The v2 work-journal evidence proved private `0600`, single-link rejection
publication and authoritative rejected-state recovery after restart while
preserving exact claimed-attempt replay with no network after commit. The run
uploaded separate spool and journal evidence artifacts. This admits ADR-051
and closes Slice 2.14; execution, lease supervision, timers, and cleanup remain
disabled.

### ADR-052: Only terminal control-plane acknowledgement completes local work

Slice 2.15 closes the lifecycle gap left deliberately by ADR-051. A durable
claim must block new acquisition while execution or evidence delivery may
still be outstanding, but it cannot block forever after the control plane has
accepted the terminal event. Local runtime exit, terminal draft creation,
spool commit, or an HTTP response observed before durable acknowledgement are
insufficient completion authority. The only admitted proof is the local event
spool's recovered terminal state with zero pending events and an
acknowledgement cursor equal to the committed final sequence.

The work journal gains an immutable completion record after its claim:

```text
pending_claim -> claimed -> completed
pending_claim -> rejected(control_plane_conflict)
```

Completion and rejection remain mutually exclusive. Completion stores the
delivery key, execution digest, spool attempt key, acknowledged terminal
sequence, and commit timestamp. It does not copy event payloads or delete the
claim. The journal validates that the supplied execution is byte-equivalent to
the durable claim before publishing completion. A second identical completion
is a replay; conflicting evidence fails closed.

A one-shot `WorkCompletionCoordinator` reads the spool through a narrow port,
requires `terminal=true`, `pendingEvents=0`, a positive final sequence, and
`acknowledgedSequence=lastSequence`, then commits completion. The real
`LocalEventSpool.inspect(execution)` already validates manifest execution
digest, attempt identity, segment/commit integrity, terminal event position,
and acknowledgement identity before exposing that state. Incomplete or
unacknowledged evidence returns an explicit not-ready result and never mutates
the journal.

`WorkAdmissionCoordinator` treats completed and rejected entries as retained
history, while pending and claimed entries remain actionable blockers ordered
by admission time and delivery ID. Therefore a later call may acquire new work
only after the previous claim has durable terminal acknowledgement and durable
completion. A crash before completion publication re-evaluates the same
spool proof; a crash after publication replays local completion without
network traffic or deletion.

Slice 2.15 does not execute a task, generate lifecycle drafts, send events,
schedule heartbeats, observe cancellation, delete spool or journal evidence,
compact retention, or enable a process loop. It only joins two already durable
truths. `LocalRunnerNotEnabledError` remains unchanged.

Validation amendment, 2026-07-31: implementation commit `a48a61f` passed
local formatting, TypeScript, ESLint, 204 runner-local tests, all workspace
tests, Phase 1/2 dependency-boundary audits, production builds, and the
low-severity dependency audit with no known vulnerabilities. GitHub Actions
run `30654149358` passed every PostgreSQL and API integration, the Chromium
product journey, all builds, and both Linux native durability probes. The v3
work-journal evidence proved `completion.json` private `0600` mode,
single-link immutable publication, completed-state recovery after restart,
exact attempt replay, and no network after commit. Separate spool and journal
evidence artifacts were uploaded. This admits ADR-052 and closes Slice 2.15;
execution, lease supervision, cancellation monitoring, and cleanup remain
disabled.

### ADR-053: Cancellation policy is durable before a heartbeat can command it

Slice 2.16 turns the existing heartbeat `cancel` hint into a complete,
identity-bound command without inventing policy in the runner. The current
`RunnerCancellationV1` requires `requestedAt`, `gracePeriodMs`, and `reason`,
while the control plane persists and returns none of them. Mapping every hint
to an arbitrary local default would make replay non-deterministic and erase
whether cancellation came from an operator, budget, policy, or shutdown
decision.

Cancellation requests therefore freeze a closed reason and bounded grace
period in `runner_task_cancellations`; PostgreSQL supplies `requested_at`.
Schema compatibility advances to 9. Existing rows backfill to the historical
semantics `reason=operator` and a conservative 5-second grace before new
`NOT NULL` checks are applied. The per-task immutable cancellation row remains
the source of replay truth; later duplicate requests return its original
policy rather than replacing it.

Heartbeat response v1 becomes a strict discriminated union. `continue`
contains the renewed database-clocked lease only. `cancel` additionally
contains the persisted cancellation policy with the database timestamp. The
scheduler renews the exact active fence and reads task status plus cancellation
policy in the same transaction. A `cancellation_requested` task without one
complete cancellation row fails closed instead of emitting a partial command.
Runner-authenticated request bodies still cannot choose cancellation policy.

A one-step `LeaseSupervisor` validates one frozen execution, sends an exact
task/attempt/fence heartbeat with a trusted bounded lease duration, and returns
one closed outcome. `continue` exposes the new lease timestamp. `cancel`
constructs `RunnerCancellationV1` solely from the execution identity and
persisted server policy, validates it, invokes the injected cancellation port,
then returns the applied command. An authenticated conflict is reported as
`stale`; abort, timeout, network, authentication, server, size, and protocol
failures remain errors. The supervisor performs no hidden retry.

The supervisor intentionally owns no clock or timer. It does not decide when
to heartbeat, calculate a safety margin, mutate the immutable journal claim,
claim new work, execute a sandbox, or emit `task.cancelled`. A later session
loop must treat `stale` as loss of authority and will require its own fail-stop
design before execution can be enabled. `LocalRunnerNotEnabledError` remains
unchanged.

Validation amendment, 2026-07-31: implementation commit `0e84b3b` passed
local formatting, TypeScript, ESLint, all workspace unit tests, Phase 1/2
dependency-boundary audits, and production builds. GitHub Actions run
`30655485955` passed schema compatibility 9 migration on PostgreSQL 17, every
database/API/runner integration, 209 runner-local tests, both Linux native
durability probes, the Chromium product journey, and all production builds.
The authenticated transport journey proved that the database-frozen reason,
grace period, and timestamp reach the exact fenced heartbeat; supervisor tests
proved exact identity mapping, cancel-only invocation, explicit stale
classification, error propagation, and serialized calls. This admits ADR-053
and closes Slice 2.16; heartbeat scheduling, execution, terminal event
generation, and production runner enablement remain disabled.

### ADR-054: Sandbox cancellation is bound before execution can start

Slice 2.17 connects the cancellation port admitted by ADR-053 to the OCI
backend without introducing a runner loop. A cancellation command can arrive
before container creation, while creation is crossing its publication
boundary, or after the sandbox becomes active. Calling only
`NerdctlSandboxBackend.cancel` is insufficient in the first case because no
active sandbox exists yet; retaining only an `AbortSignal` is insufficient in
the last case because an already-running container must receive the durable
grace policy.

Each admitted execution therefore receives one `SandboxCancellationScope`
before any preparation or execution work. The scope validates and freezes the
complete execution identity, exposes one AbortSignal for the whole future
execution path, and implements the `RunnerCancellationTarget` port. A valid
cancel command must exactly match runner, task, attempt, and fence. The scope
aborts first, then asks the backend to stop the exact owned sandbox with the
server-frozen grace period. A missing active sandbox is an accepted pre-start
cancellation: any later process start receives an already-aborted signal and
the backend cleanup path remains authoritative.

The first valid cancellation command is immutable. Concurrent and later
byte-equivalent calls share one in-flight/result promise and invoke backend
cancellation at most once. A different identity or different cancellation
policy fails closed and cannot abort or target the bound execution. Backend
errors are retained and replayed to duplicate callers rather than retried;
the scope never converts an uncertain engine result into success.

The scope does not own heartbeat timing, task acquisition, source or request
materialization, sandbox execution, lifecycle-event generation, spool
publication, acknowledgement, or journal completion. It is an in-memory
single-attempt authority seam. Restart behavior continues to derive from the
durable journal and server cancellation row; a later session coordinator must
create a fresh scope around recovered execution before performing work.
Production execution remains disabled.

Validation amendment, 2026-07-31: implementation commit `c35bf7b` passed
local formatting, TypeScript, ESLint, 219 runner-local tests, all workspace
tests, Phase 1/2 boundary audits, and production builds. GitHub Actions run
`30656584157` passed every PostgreSQL, authenticated API, and runner
integration, both Linux native durability probes, the Chromium journey, and
all builds. Deterministic scope tests proved abort-before-backend ordering,
pre-start cancellation, exact identity and grace forwarding, independent
identity mismatch rejection, immutable policy, concurrent deduplication, and
replayed backend uncertainty. This admits ADR-054 and closes Slice 2.17;
session scheduling, execution, event generation, and production enablement
remain disabled.

### ADR-055: Frozen budgets are projected once and never silently weakened

Slice 2.18 defines the missing pure boundary between a validated
`RunnerExecutionV1` and the task-runtime/OCI inputs. Passing task fields
directly into independent constructors would distribute security policy across
the future session loop and make it possible for one layer to clamp, round, or
omit a hard limit without another layer observing the change.

An `ExecutionPlanProjector` therefore validates the complete frozen execution
against one trusted local policy and returns an immutable pair: a canonical
`RuntimeRequest` and a `SandboxResourceProfile`. The projector has no I/O,
clock, environment access, mutable cache, or default configuration. Invalid,
unsupported, over-policy, arithmetically unsafe, or unrepresentable tasks fail
before source materialization or image admission.

Memory and PID limits map exactly after proving they do not exceed runner
maximums. The task writable-byte budget is an aggregate limit across all three
writable tmpfs mounts. Trusted fixed `/tmp` and `/dev/shm` reservations are
subtracted with checked integer arithmetic; the positive remainder becomes
both `/workspace` capacity and the runtime source-copy limit. The three profile
values must sum exactly to the frozen task limit. Network allowlists remain
unsupported by the local backend, so only disabled networking with zero egress
is projectable.

CPU time is converted into a cgroup CPU-rate ceiling only in combination with
the frozen wall-time ceiling. Trusted integer quota-period, minimum-quota, and
maximum-quota microseconds define the representable CPU range and quantum. The
period must be a power of ten so every integer quota ratio has a finite decimal
representation for the OCI `--cpus` boundary. The projector calculates the
quota with exact integer arithmetic and rounds down, never up, then proves
`quota / period * wallTimeMs <= cpuTimeMs`. Ratios below the trusted minimum or
above the trusted maximum fail; they are not widened to a convenient value.
The runtime retains the frozen aggregate wall limit and command-count limit.

Runtime child-output capacity is derived with checked addition from the frozen
log budget and measurement-result maximum. This derived bound must fit the
trusted runtime output maximum. It does not replace the separate outer framed
protocol cap or control-plane log quota. Artifact and egress budgets are not
reinterpreted by this slice.

The projector does not materialize a source or request, admit an image, start a
sandbox, supervise a lease, create event envelopes, or persist evidence. A
later one-attempt coordinator may consume only this validated plan and the
opaque capabilities from the existing materializers. Production execution
remains disabled.

Validation amendment, 2026-07-31: implementation commit `0c3a925` passed
local formatting, TypeScript, ESLint, 232 runner-local tests, all workspace
tests, Phase 1/2 dependency-boundary audits, and production builds. GitHub
Actions run `30657580224` passed every PostgreSQL, authenticated API, and
runner integration, both Linux native durability probes, the Chromium product
journey, and all builds. Projection tests proved exact frozen-field mapping,
aggregate writable equality, checked overflow/underflow, unsupported-network
rejection, deep immutability, and property-tested downward CPU quantization.
This admits ADR-055 and closes Slice 2.18; materialization coordination,
execution, supervision timing, event generation, and production enablement
remain disabled.

### ADR-056: Attempt preparation is one owned, compensating session

Slice 2.19 defines the first side-effecting consumer of the frozen execution
plan. Image admission, source-artifact resolution, and source materialization
cannot be left as unrelated calls in a future session loop: cancellation or a
failure between those calls could leak a source tree, accept a capability for
the wrong task, or allow a second caller to prepare the same attempt with
different authority.

An `AttemptPreparationCoordinator` is therefore bound at construction to one
validated `RunnerExecutionV1`. It projects the execution before any I/O, then
resolves the exact `(snapshotId, digest)` through a narrow trusted
source-artifact port, admits the exact image digest and architecture, and
materializes the source for the exact lease identity. Every returned opaque
capability is revalidated against the frozen execution before it can leave the
coordinator. The coordinator has no ambient configuration or fallback image,
source, identity, or budget.

Preparation is a one-shot process-local operation. Concurrent and later calls
share the first preparation promise; a failure is retained rather than causing
an implicit retry with potentially changed local state. The first caller's
cancellation signal is authoritative. The signal is checked before I/O and at
every awaited boundary. Attempt-scoped source resolution and materialization
receive that same signal, but a later caller cannot replace it. Shared image
admission deliberately does not receive an attempt signal: its in-flight
promise is cached by image identity, so one attempt must not cancel admission
needed by another. Cancellation is checked immediately before and after that
shared operation. If cancellation or validation fails after a source
capability has been issued, the coordinator releases that exact source before
rejecting. Cleanup failure is surfaced as cleanup uncertainty and is never
converted into successful preparation.

The prepared result is immutable and owns exactly one materialized source.
Release is explicit, idempotent, and concurrency-deduplicated; release failure
is retained and replayed. Image admission remains catalog-owned and
process-cached, so it has no per-attempt release. Runtime-request
materialization remains executor-owned because its existing `finally` block is
the narrowest correct lifetime. This slice does not start a sandbox, create a
heartbeat timer, translate runtime frames, publish evidence, complete work, or
enable the production runner.

Opaque image, artifact, and source capabilities are intentionally not durable
and are never serialized into the work journal. On runner startup, the global
owner must recover stale sandbox and source resources before admitting session
work. A claimed execution recovered from the durable journal receives a new
preparation coordinator, which re-projects, re-resolves, re-admits, and
re-materializes from the same frozen identities. Per-attempt preparation must
not call global recovery because doing so could delete another live session's
owned resources.

Validation amendment, 2026-07-31: implementation commit `2645428` passed
local formatting, TypeScript, ESLint, 248 runner-local tests, all workspace
tests, Phase 1/2 dependency-boundary audits, and production builds. GitHub
Actions run `30658886159` passed every PostgreSQL, authenticated API, and
runner integration, both Linux native durability probes, the Chromium product
journey, and all builds. Deterministic preparation tests proved pre-I/O
projection and cancellation, exact artifact/image/source authority,
process-local signal ownership, shared-image cancellation isolation,
concurrent one-shot replay, post-materialization compensation, explicit
cleanup uncertainty, and idempotent release. This admits ADR-056 and closes
Slice 2.19; startup recovery orchestration, runtime execution, lifecycle event
publication, work completion, and production enablement remain disabled.

### ADR-057: Startup recovery is a one-way gate before work admission

Slice 2.20 defines the process-level recovery barrier required by ADR-056.
Attempt preparation cannot safely begin while stale sandboxes or source trees
from a previous runner process may still exist. Letting each session invoke
global recovery would be worse: a live session could have its owned resources
deleted by another session using the same deployment and runner identity.

A fresh runner process therefore creates exactly one
`RunnerStartupRecoveryBarrier` around fresh sandbox-backend and source-
materializer instances. All callers share one recovery promise. Success
returns an immutable count of removed sandbox and source resources; failure is
retained and replayed. There is no in-process retry, partial-success
conversion, timeout, cancellation signal, or degraded mode. The composition
root must not construct work-admission/session services until the barrier has
succeeded.

Recovery is deliberately sequential. Exact-owned sandboxes are removed first
because they may still mount exact-owned source directories. Only after
sandbox recovery succeeds may source staging and published directories be
removed. The two cleanup operations must not run in parallel. Each underlying
owner remains responsible for deployment/runner ownership proofs and
fail-closed removal; the barrier rejects invalid cleanup counts rather than
inventing success.

Durable work-journal and event-spool roots are not cleanup targets. Their
existing `open()` paths validate ownership, checksums, and crash remnants and
must succeed independently before later composition. Opaque capabilities are
not reconstructed by the barrier. After successful recovery, a claimed work
item can be loaded from the journal and receive a fresh preparation
coordinator. This slice does not open stores, acquire work, create sessions,
start heartbeats, execute sandboxes, publish events, or enable the runner.

Validation amendment, 2026-07-31: implementation commit `0b7d64e` passed
local formatting, TypeScript, ESLint, 262 runner-local tests, all workspace
tests, Phase 1/2 dependency-boundary audits, and production builds. GitHub
Actions run `30659524149` passed every PostgreSQL, authenticated API, and
runner integration, both Linux native durability probes, the Chromium product
journey, and all builds. Deterministic barrier tests proved strict sandbox-
before-source ordering, one-shot concurrent replay, retained stage-specific
failure, rejection of every invalid count class, and immutable exact results.
This admits ADR-057 and closes Slice 2.20; durable-store composition, work
admission, attempt sessions, execution, events, and production enablement
remain disabled.

### ADR-058: Source transfer is attempt-bound, streamed, and verified locally

Slice 2.21 resolves the abstract source-artifact port introduced by ADR-056
without weakening the frozen task contract. `ExperimentTaskV2` intentionally
freezes a source snapshot identifier and digest but not transport metadata.
Adding required byte length or media type to that version would invalidate
already durable tasks. Treating unknown-size response bytes as a verified
artifact would instead remove the hard archive bound.

A `BoundedSourceArtifactResolver` is therefore constructed for one exact lease
identity and one trusted maximum archive size. It asks a narrow runner source
transport for the exact `(identity, snapshotId, digest)` and accepts only the
canonical source-snapshot media type, a positive safe declared length within
the local bound, and a streamed body. The same attempt cancellation signal is
forwarded and checked while iterating bytes. The stream is written through the
existing `ArtifactStore.put`, which independently enforces declared length,
maximum length, and SHA-256 identity before issuing an opaque
`VerifiedArtifact`.

Resolution is one-shot and process-local. Concurrent and later exact calls
share the first result or retained failure. A different snapshot identifier,
digest, or signal authority fails before transport I/O. Missing content,
redirect interpretation, credentials, HTTP details, retries, and signed URL
policy remain transport responsibilities; the resolver never accepts a path,
URL, buffer, or forged artifact from that boundary.

The future HTTP transport must authenticate the runner and authorize the
exact active task/attempt/fence before returning bytes, but that route and its
backing object-store read model are a later slice. This slice does not change
task schemas, persist capabilities, materialize tar contents, admit images,
prepare a full attempt, execute a sandbox, or enable the runner.

Validation amendment, 2026-07-31: implementation commit `3033a0b` passed
local formatting, TypeScript, ESLint, 290 runner-local tests, all workspace
tests, Phase 1/2 dependency-boundary audits, and production builds. GitHub
Actions run `30660344955` passed every PostgreSQL, authenticated API, and
runner integration, both Linux native durability probes, the Chromium product
journey, and all builds. Adversarial resolver tests proved exact attempt-bound
transport input, one-shot source/signal authority, malformed descriptor and
size rejection, streaming truncation/overflow/digest detection, pre/mid/post
cancellation, no publication after interrupted writes, and rejection of
forged artifact capabilities. This admits ADR-058 and closes Slice 2.21;
authenticated HTTP source serving, backing object-store reads, attempt session
composition, execution, and production enablement remain disabled.

### ADR-059: Source bytes require a current fenced lease and immutable catalog

Slice 2.22 connects ADR-058's transport port to the control plane. Bearer
authentication alone is insufficient: a valid runner credential must not read
an arbitrary snapshot, a source from another task, or bytes after its lease is
stale. Route parameters and request JSON are untrusted claims, not authority.

Source object metadata is therefore stored in an immutable PostgreSQL catalog
keyed by `snapshotId`, with exact digest, positive byte length, canonical
source-snapshot media type, and creation time. The content-addressed object is
published before its catalog row; an orphan object is acceptable, while a
catalog row without a locally verifiable object fails closed. Catalog identity
is never inferred from a filesystem path or caller-provided length.

The runner gateway authorizes a source read in one database transaction. It
requires the authenticated runner, task, attempt, fence, unexpired current
lease, executable task version, frozen task `(snapshotId, digest)`, and catalog
row to match exactly. Mismatch, expiry, cancellation/terminal state, missing
metadata, or stale fence returns no read authority. The transaction returns
only immutable metadata; it never opens or streams a file.

The API then asks the configured `ArtifactStore` to verify the catalog digest
and length and streams its one-shot read directly in the response. The route
is `POST` with validated JSON so fence/source identity is explicit; redirects
are never used. A successful response carries exact `Content-Type` and
`Content-Length`. Errors remain bounded JSON. If the store is absent,
unverifiable, changes during read, or fails mid-stream, the request does not
become successful evidence and the runner's local store cannot issue a
verified capability.

`RunnerHttpClient` implements `RunnerSourceSnapshotTransport` with the same
credential, HTTPS/origin policy, timeout, redirect rejection, and caller
signal used by control messages. It validates status and headers before
exposing an async iterable over the response body, never buffers the complete
archive, and enforces a configured transport byte ceiling while streaming.
The ADR-058 resolver performs the independent final size and digest proof.

This slice does not add source upload UI, signed URLs, retention collection,
task creation from repositories, source extraction, attempt sessions, sandbox
execution, or runner enablement. A later ingestion slice must publish object
bytes before inserting the immutable catalog row.

Validation amendment, 2026-07-31: implementation commit `94e1a25` plus
integration-fixture correction `1fd11b8` passed local formatting, TypeScript,
ESLint, Phase 1/2 dependency-boundary audits, 295 runner-local tests, all
workspace tests, and production builds. GitHub Actions run `30662277227`
passed the schema-version-10 PostgreSQL migration, source catalog and
current-lease authorization integrations, authenticated API byte streaming,
cancellation-time revocation, both Linux native durability probes, the
Chromium product journey, and all builds. Adversarial client tests proved
manual redirect handling, exact media type and length, configured and streamed
byte limits, truncation/overflow rejection, single consumption, caller abort,
timeout, and ADR-058 resolver composition. This admits ADR-059 and closes
Slice 2.22; source ingestion, extraction, attempt-session composition,
execution, and production runner enablement remain disabled.

### ADR-060: Irreversible execution requires a durable start barrier

The durable work journal currently distinguishes a claimed delivery from a
completed delivery, but it does not record whether sandbox execution has
crossed its irreversible boundary. A future session loop that simply resumes a
`claimed` item after restart could run the same attempt again when the process
crashed after starting the sandbox but before committing terminal evidence.
The local sandbox has no network and no host-writable mount, but duplicate
execution would still violate attempt identity and make measurements
ambiguous.

Before the first sandbox process may be created, the runner must therefore
publish an immutable `execution-start.json` record in the existing private
work-journal item. The checksummed record binds delivery key, durable execution
digest, attempt key, and runner-clock timestamp. Publication uses the same
temporary-write, file-sync, atomic-rename, directory-sync discipline as other
journal records. Exact retries return the first record; identity drift,
start-before-claim, start-after-rejection, and start-after-completion fail
closed.

An execution-start record changes local recovery semantics. A claimed item
without the record remains safe to prepare. An item with the record and no
durably acknowledged terminal completion is `execution_started`, an
indeterminate outcome that `WorkAdmissionCoordinator` returns ahead of any new
acquisition and never presents as executable work. This deliberately trades
availability for at-most-once local attempt execution. A later recovery slice
must reconcile that indeterminate attempt with its current server lease or
expiry; it may not infer success, failure, or retry from local absence.

Completion remains legal without an execution-start record because a durable
cancellation may terminate an attempt before sandbox start. Completion after a
start record remains legal and takes precedence in the public state. The
record does not enable execution, add a runner loop, contact the control plane,
generate terminal evidence, or garbage-collect journal items.

Validation amendment, 2026-07-31: implementation commit `cb9bae3` plus the
cross-platform fixture-mode correction `1a652ec` passed local formatting,
TypeScript, ESLint, Phase 1/2 dependency-boundary audits, 306 runner-local
tests, all workspace tests, and production builds. GitHub Actions run
`30663648242` passed PostgreSQL migrations and integrations, API and runner
integrations, the Linux native work-journal v4 probe, the Chromium product
journey, and all production builds. The native probe proved private `0600`
publication, a single hard link, retained start time across restart, and
completion precedence. Fault-injection tests covered all six publication
boundaries; recovery tests proved that durable started work returns
`indeterminate` without a claim or acquisition request. This admits ADR-060
and closes Slice 2.23; lease reconciliation, session scheduling, sandbox
execution, evidence generation, and runner enablement remain disabled.

### ADR-061: Indeterminate starts retire only through serialized lease truth

An `execution_started` journal item proves that an attempt may have crossed an
irreversible local boundary, but it cannot prove a runtime outcome. The runner
must never replay it, infer failure from a missing sandbox, renew its lease, or
discard it from a local clock comparison. Recovery needs an exact,
database-clocked control-plane command.

The authenticated runner may therefore reconcile only its exact
`(runnerId, taskId, attemptId, fence)` identity. The scheduler locks the task
and attempt together before classifying them. A current active attempt with an
unexpired lease returns `current` without extending the lease or changing any
row. An active attempt whose lease is expired is transitioned through the same
attempt expiry, retry-safety, cancellation, task projection, and transactional
outbox rules as the bounded expiry reconciler. A terminal attempt, terminal
task, or superseded fence returns an immutable `retired` observation. Missing
or foreign identity fails closed rather than revealing scheduler state.

This cannot be implemented as a read-only expiry probe. A heartbeat that began
before expiry could otherwise wait behind the probe and renew after the runner
had treated the attempt as retired. Row locking plus an irreversible expiry
transition makes retirement monotonic. A reconciliation that began before
expiry may conservatively return `current`; it does not create an unsafe
retirement.

The runner persists a checksummed `execution-retirement.json` before allowing
admission to move past the indeterminate item. It binds the delivery, durable
execution digest, attempt key, server observation time, and closed retirement
reason. Exact replay is byte-stable; conflict, retirement before execution
start, or retirement after acknowledged completion fails closed. Public local
state becomes `retired`, distinct from `completed`: retirement proves only
that the old attempt can no longer write, not that terminal evidence was
acknowledged.

`WorkAdmissionCoordinator` performs at most one reconciliation per call. A
`current` response remains `indeterminate`; a `retired` response commits the
local retirement and returns it. Only a later admission call may skip retired
work and acquire another delivery. Network ambiguity and malformed responses
leave the item indeterminate. This slice adds no polling loop, heartbeat,
terminal-event invention, sandbox execution, garbage collection, or production
runner enablement.

Validation amendment, 2026-07-31: implementation commit `5497fd7` plus the
isolated PostgreSQL fixture correction `5c28746` passed local formatting,
TypeScript, ESLint, Phase 1/2 dependency-boundary audits, 316 runner-local
tests, all workspace tests, and production builds. GitHub Actions run
`30665390494` passed PostgreSQL exact-reconciliation, heartbeat-race, shared
expiry, authenticated API, and runner integrations; the Linux native
work-journal v5 probe; the Chromium product journey; and every production
build. Tests proved that current reconciliation does not renew a lease, an
expired exact attempt atomically retires while its racing heartbeat becomes
stale, retirement is durably published across all six fault boundaries, and
new acquisition waits for a later call. This admits ADR-061 and closes Slice
2.24; polling, sandbox execution, invented terminal evidence, cleanup, and
production runner enablement remain disabled.

### ADR-062: Local failures become evidence only through a closed policy

The future attempt session must turn some locally observed failures into one
terminal event batch, but arbitrary JavaScript errors are not evidence. Error
messages may contain host paths, commands, credentials, or unstable library
text; phase alone is also insufficient to distinguish a task failure from an
ambiguous delivery outcome. The session must not serialize `Error.message`,
`cause`, stack traces, or adapter-specific objects.

A pure local failure policy therefore accepts only a closed runner-owned
failure code, whether execution had durably started, and bounded provenance
such as elapsed duration. It emits exactly one validated terminal draft with a
fixed product-authored message and classification. Projection, source,
image-admission, materialization, request-envelope, sandbox-backend, runtime
protocol, cleanup, and unexpected local failures map to explicit stable codes.
Budget classification is used only when a trusted bounded component identifies
one exact frozen budget dimension. Runtime-reported action, evaluation, and
budget outcomes continue through ADR-055's lifecycle adapter rather than this
policy.

Cancellation evidence requires an authenticated server cancellation directive;
an `AbortSignal`, process shutdown, timeout exception, or missing local resource
alone cannot authorize `task.cancelled`. The policy validates the directive and
emits a bounded cancellation draft without retaining its operator-facing
reason. Transport ambiguity, event rejection, spool corruption/capacity,
terminal acknowledgement failure, and journal corruption emit no new terminal
draft because the durable evidence or server outcome may already exist.

The policy is deterministic and has no filesystem, network, clock, sandbox, or
journal dependency. It does not append to the spool or complete work. A later
session coordinator supplies its own monotonic duration, persists the returned
draft through the existing one-segment spool, drains acknowledgements, and only
then invokes work completion. This slice does not compose or enable that
session.

Validation amendment, 2026-07-31: implementation commit `2527aad` passed local
formatting, TypeScript, ESLint, Phase 1/2 dependency-boundary audits, 343
runner-local tests, all workspace tests, production builds, and the
low-severity dependency audit. Its 28 focused policy tests exhaustively proved
the closed failure and budget mappings, authenticated cancellation authority,
redaction under arbitrary exception text, immutable outputs, and explicit
no-evidence results for ambiguous boundaries. GitHub Actions run `30666098009`
passed every PostgreSQL, authenticated API, and runner integration, both Linux
native durability probes, the Chromium product journey, and all production
builds. This admits ADR-062 and closes Slice 2.25; session composition,
execution, persistence, and production runner enablement remain disabled.

### ADR-063: Lease cadence is fail-stop and never local authority

A future attempt session cannot safely call the one-step `LeaseSupervisor`
from an ordinary interval. Overlapping requests can reorder directives, a
timer callback can outlive its attempt, and treating a locally calculated
deadline as lease truth could let a sandbox continue after the control plane
has fenced it. Conversely, retrying an ambiguous heartbeat inside the cadence
would hide the interval during which authority was unknown.

One `LeaseAuthorityMonitor` therefore owns the sequential heartbeat cadence
for exactly one frozen execution. It sends the first heartbeat immediately,
then waits through an injected abort-aware scheduler only after a successful
`renewed` result. Configuration fixes a positive safe-integer heartbeat period
at no more than one third of the requested lease duration. This ratio creates
retry opportunity for the control plane and observability, but it does not
prove authority: only each authenticated heartbeat response does. The monitor
never compares `Date.now()` with `leasedUntil` or `leaseExpiresAt`, and it never
overlaps heartbeat calls.

The monitor has a distinct attempt-revocation port. `stale` revokes local
execution and returns a closed stale result. Any transport, protocol,
authentication, server, timeout, cancellation-application, or scheduler
failure first invokes the same revocation port and then rejects with bounded
monitor-owned classification while retaining the original error only as an
in-memory cause. Revocation aborts attempt work before it tries to stop the
owned sandbox. Its local reason and configured stop grace are operational
policy only; they cannot authorize a `task.cancelled` event. If revocation also
fails, both causes remain available in memory and the monitor still fails
closed.

An authenticated `cancel` result continues through ADR-053 and ADR-054: the
supervisor applies the immutable server directive, and the monitor returns its
closed cancelled result without invoking a competing local revocation policy.
An explicit caller stop is accepted only as lifecycle coordination after the
caller no longer needs lease authority; it aborts a scheduled wait, performs
no heartbeat, no revocation, and returns `stopped`. An already in-flight
heartbeat is allowed to settle before stop completes so its outcome cannot be
silently discarded. The future attempt session must request stop only after
terminal acknowledgement and durable work completion.

The monitor owns no acquisition, preparation, runtime execution, event
mapping, spool write, acknowledgement, completion, retry, backoff, wall clock,
or process loop. This slice adds the local revocation seam to the existing
identity-bound cancellation scope and tests it with an injected deterministic
scheduler, but does not compose or enable a production runner session.

Validation amendment, 2026-07-31: implementation commit `c400b14` passed local
formatting, TypeScript, ESLint, Phase 1/2 dependency-boundary audits, 364
runner-local tests, all workspace tests, production builds, and the
low-severity dependency audit. Sixteen focused monitor tests proved bounded
configuration, immediate-first and non-overlapping cadence, owner stop during
wait and in-flight heartbeat, cancellation/stale races, redacted uncertainty,
revocation failure aggregation, and the absence of wall-clock authority. The
expanded cancellation-scope suite proved abort-before-stop ordering,
idempotent local revocation, and first-policy-wins behavior across local and
authenticated termination. GitHub Actions run `30666995698` passed every
PostgreSQL, authenticated API, and runner integration, both Linux native
durability probes, the Chromium product journey, and all production builds.
This admits ADR-063 and closes Slice 2.26; attempt-session composition,
execution, evidence persistence, and production runner enablement remain
disabled.

### ADR-064: The runtime executor cannot bypass the durable start barrier

ADR-060 requires durable `execution-start.json` publication before the first
sandbox process may be created, but the current `RuntimeSandboxExecutor` has no
start-barrier dependency. Calling the journal from a future outer session
before invoking the executor would be safe against duplicate execution, yet it
would mark the attempt indeterminate even when request-envelope materialization
failed and the sandbox backend was never reachable. Leaving the callback
optional would preserve a production path that bypasses the invariant.

Every runtime execution therefore requires one `RuntimeExecutionStartBarrier`
capability. The executor validates and materializes the read-only runtime
request first, checks cancellation, then awaits `cross()` as the final
asynchronous operation before invoking `executeRuntime`. It performs no await,
timer, event dispatch, or caller callback between a successful crossing and
the backend method invocation. The backend still receives the bound signal, so
cancellation racing or following the barrier prevents or stops owned process
work while the conservative start record remains correct.

The request envelope is released on every post-materialization path, including
pre-barrier cancellation, barrier failure, synchronous backend failure, and
normal completion. A failed or indeterminate barrier never invokes the
backend. Release failure becomes one stable runner-owned
`request_release_failed` error. When execution also failed, an in-memory
aggregate retains both causes without copying either into product evidence, so
cleanup uncertainty cannot erase whether the start barrier was crossed. Once
`cross()` resolves, any later failure is post-start even if the backend proves
that no container became active; restart logic must continue to treat the
attempt as indeterminate until ADR-061 retirement or acknowledged terminal
completion.

`DurableExecutionStartBarrier` binds one validated execution and delivery ID
to `LocalWorkJournal.commitExecutionStart`. Its first `cross()` call owns one
promise; concurrent and later calls share the exact result or failure without
issuing another journal operation. It accepts only the journal's
`execution_started` state and retains no mutable record. This capability
contains no filesystem implementation of its own and cannot choose a different
execution on replay.

This slice changes the low-level executor contract and all deterministic/native
fixtures so a barrier is always explicit. It does not admit work, start lease
monitoring, map failures, append or send evidence, complete work, compose an
attempt session, or enable the production runner entry point.

Validation amendment, 2026-07-31: cleanup-policy documentation commit
`1aaf429` preceded implementation commit `2537dff`. Local formatting,
TypeScript, ESLint, Phase 1/2 dependency-boundary audits, 379 runner-local
tests, all workspace tests, production builds, and the low-severity dependency
audit passed. Eight durable-barrier tests proved exact frozen identity,
pre-access validation, concurrent/sequential single publication, replayed
uncertainty, and fail-closed unexpected states. The 15-test runtime executor
suite proved materialize/barrier/backend/release order, cancellation on both
pre-barrier sides, no backend call on barrier failure, synchronous invocation
failure cleanup, stable release classification, and dual-cause aggregation.
GitHub Actions run `30667861578` passed every PostgreSQL, authenticated API,
and runner integration, both Linux native durability probes, the Chromium
product journey, and all production builds. This admits ADR-064 and closes
Slice 2.27; admission, session composition, evidence production, and runner
enablement remain disabled.

### ADR-065: Durable terminal evidence recovers before attempt retirement

An `execution_started` journal item may already have a complete terminal event
batch in the local spool when the runner restarts. ADR-061 currently sends such
work directly to exact lease reconciliation. If the control plane committed an
event but its acknowledgement was lost, reconciliation can report the attempt
retired and the local journal can publish retirement while its byte-identical
terminal evidence remains recoverable. Server outcome must not replace durable
local evidence merely because delivery was interrupted.

`TerminalEvidenceRecoveryCoordinator` therefore inspects only an existing
exact-attempt spool before an `execution_started` item can be reconciled. A new
non-creating `inspectExisting` operation returns `null` when the attempt has no
spool directory; admission probing must not allocate a manifest, consume
capacity, or change filesystem state. An empty existing manifest is equivalent
to no evidence. Any partial, non-terminal, identity-conflicting, or corrupt
state fails closed.

For a committed terminal batch, recovery freezes its initial pending-event
count and invokes the existing sequential sender exactly that many times. Each
step must acknowledge one event; premature `idle`, count drift, malformed
acknowledgement, transport ambiguity, rejection, or spool failure aborts the
operation. It does not reconcile the lease in the same admission call. A later
call retries the same durable bytes, allowing the server to return its replay
acknowledgement without allocating a new event ID or sequence.

After the bounded drain, the existing completion coordinator must observe the
exact terminal acknowledgement and durably commit local work completion. A
`not_ready` result after the proven drain is an invariant failure. Already
fully acknowledged terminal evidence skips sending and proceeds directly to
completion. Recovery returns one frozen `completed` result containing the
durable work state; it never appends drafts or creates evidence.

`WorkAdmissionCoordinator` consults this recovery port only for
`execution_started` work and does so before exact retirement reconciliation.
Successful completion is returned as a distinct admission result and ends the
call; acquiring another delivery requires a later call. Absent evidence falls
through to ADR-061 reconciliation. Claimed pre-start cancellation evidence is
not addressed by this slice and remains a future session/recovery decision.

This slice adds no executor, heartbeat, timer, event mapping, fresh spool
append, garbage collection, polling loop, or runner enablement. It establishes
the restart ordering needed before a single-attempt session can safely publish
terminal evidence.

Validation amendment, 2026-07-31: implementation commit `c7f5f11` passed every
local repository gate, including 398 runner-local tests and the low-severity
dependency audit. Sixteen focused recovery tests proved bounded replay,
identity and state validation, ambiguity preservation, completion ordering,
and admission suppression. A non-creating inspection test proved that an
absent attempt leaves no filesystem state, while a real restart test reopened
both the durable journal and a partially acknowledged spool, replayed only the
remaining event, and committed exact work completion. GitHub Actions run
`30668714816` passed every PostgreSQL, authenticated API, and runner
integration, both Linux native durability probes, the Chromium product
journey, and all production builds. This admits ADR-065 and closes Slice 2.28;
execution, fresh event creation, claimed pre-start evidence recovery, polling,
and runner enablement remain disabled.

### ADR-066: Claimed work recovers terminal evidence before becoming ready

Terminal evidence can be valid before sandbox execution starts. Source
resolution, image admission, request preparation, cancellation, or another
controlled pre-start failure may produce a terminal batch while the durable
work journal remains `claimed`. If admission returns that work as `ready`
without inspecting its spool, a restart can execute an attempt that already
has terminal evidence or strand an acknowledgement that the control plane has
committed.

`WorkAdmissionCoordinator` must therefore invoke the same
`TerminalEvidenceRecoveryCoordinator` for both `claimed` and
`execution_started` work. For `claimed` work the recovery probe occurs before
the coordinator can return `ready`. A completed recovery returns the existing
`completed` admission result and ends the call. Absent or exactly empty spool
state returns `none` and permits the original ready path. Corruption,
identity conflict, partial non-terminal evidence, transport uncertainty, and
completion uncertainty fail closed and suppress execution and same-call
acquisition.

The `ready` result must carry the durable `deliveryId` in addition to the
frozen execution. Event publication and work completion are delivery-scoped;
the delivery identity cannot be reconstructed from a task or attempt ID. The
coordinator copies it only from the admitted journal record and returns a
frozen result. This is a local contract addition and does not alter the wire
protocol.

Recovery retains the state-dependent ordering: `claimed` work recovers before
ready, while `execution_started` work recovers before exact lease retirement
reconciliation. A successful recovery never acquires another delivery in the
same call. No new recovery algorithm or second sender is introduced; ADR-065
remains the single bounded replay path for both journal states.

This slice adds no preparation, runtime execution, heartbeat ownership, fresh
event append, failure mapping, polling loop, or runner enablement. It closes
the final admission-side evidence gap before a terminal publication
coordinator can be composed.

Validation amendment, 2026-07-31: implementation commit `0fa3686` passed every
local repository gate, including 400 runner-local tests and the low-severity
dependency audit. Focused admission tests proved that claimed terminal
evidence completes before ready, recovery ambiguity suppresses execution and
acquisition, and fresh plus recovered ready results retain the exact durable
delivery identity. The existing restart and bounded-replay suites continued
to prove byte-stable terminal recovery. GitHub Actions run `30669383760`
passed every PostgreSQL, authenticated API, and runner integration, both Linux
native durability probes, the Chromium product journey, and all production
builds. This admits ADR-066 and closes Slice 2.29; execution, fresh event
creation, polling, and runner enablement remain disabled.

### ADR-067: Fresh terminal evidence publishes through one durable recovery path

A session needs one operation that turns a validated terminal draft batch into
durable, acknowledged, locally completed work. Calling spool append, sender,
and work completion independently would expose an unsafe retry boundary: a
caller could append a batch, lose the return value, and create different event
IDs on retry. Publication must treat any exact durable batch as authoritative
before considering fresh evidence.

`TerminalEvidencePublicationCoordinator.publish` owns this boundary. Before
filesystem or network effects it parses and freezes the delivery ID,
execution, and every draft, verifies that the batch is non-empty and ends with
exactly one terminal event, and proves the work journal binds that delivery to
the byte-equivalent execution. Only `claimed`, `execution_started`, or an exact
`completed` replay may enter publication. Pending, rejected, retired, missing,
or identity-conflicting work fails closed.

Publication first invokes ADR-065 recovery. If exact terminal evidence already
exists, it drains and completes that evidence and ignores the candidate batch
for mutation purposes. This is the required retry path after append,
acknowledgement, or completion uncertainty. The drafts are still validated so
an invalid caller cannot appear successful merely because older evidence is
present. An exact completed replay returns the same durable completion without
creating or sending anything new.

Only an active work item with recovery result `none` may append. The
coordinator revalidates active journal ownership immediately before append,
then writes one lifecycle segment through `LocalEventSpool`. Spool input and
terminal-shape validation must precede attempt-manifest creation, so invalid
drafts cannot mutate the filesystem. After append, the coordinator invokes the
same recovery operation again; `none` or completion not ready at that point is
an invariant failure. Storage and transport ambiguity propagate unchanged so
admission or a later publication call can replay the durable bytes.

The coordinator serializes calls in-process. Concurrent duplicate calls yield
one append and one durable completion; later calls recover the completed
evidence. It returns a frozen result identifying whether evidence was freshly
appended or recovered, but never returns generated event IDs as authority.
The spool and control plane remain the sources of truth.

This slice adds no runtime execution, preparation composition, lifecycle
failure classification, heartbeat lifetime, polling loop, garbage collection,
or runner enablement. It creates the single terminal publication primitive
needed by a future one-attempt session.

Validation amendment, 2026-08-01: implementation commit `86d7e01` passed every
local repository gate, including 425 runner-local tests and the low-severity
dependency audit. Eighteen focused publication tests proved pre-effect input
validation, exact journal ownership, existing-evidence precedence, completed
replay, active-state revalidation, ambiguity propagation, one-append
concurrency, and invariant failure after an unrecoverable append. A real
filesystem test published through the journal, spool, sender, and completion
coordinator, reopened both durable stores, and recovered completion without a
new event ID, clock read, or network send. Spool tests proved invalid lifecycle
batches leave the attempts directory unchanged. GitHub Actions run
`30706571197` passed every PostgreSQL, authenticated API, and runner
integration, both Linux native durability probes, the Chromium product
journey, and all production builds. This admits ADR-067 and closes Slice 2.30;
execution, session composition, polling, and runner enablement remain
disabled.

### ADR-068: Cancellation propagates an authoritative termination receipt

`task.cancelled` requires a truthful `forced` value. The sandbox backend
currently returns one boolean from cancellation, but that value only says
whether an exact active sandbox was found. It does not distinguish graceful
termination from escalation to `SIGKILL`. A session must not infer terminal
evidence from that boolean or from the requested grace period.

Sandbox cancellation therefore returns one deeply frozen
`SandboxTerminationReceipt`: `absent` when no exact active fence exists, or
`terminated` with `forced: false` after an authoritative successful graceful
stop and `forced: true` only after graceful stop authoritatively fails and a
bounded kill succeeds. A container that disappears during the operation is
classified as absent rather than forced. Stop timeout, process-launch failure,
unclassified engine output, failed kill, or cleanup uncertainty throws and
produces no receipt.

The backend must not issue an unconditional kill after a successful stop.
Every path still removes only deployment-, runner-, task-, attempt-, and
fence-owned resources before returning. A failed removal makes the operation
ambiguous even if process termination was observed. Exact identity mismatch
returns `absent` without a process call.

`SandboxCancellationScope` latches the first authenticated cancellation or
local revocation as before, but its shared promise now resolves with the exact
receipt. Exact concurrent and sequential duplicates receive the same frozen
object; uncertainty is replayed as the same rejection. `LeaseSupervisor`
includes the authenticated cancellation receipt in its `cancelled` result,
and `LeaseAuthorityMonitor` preserves it unchanged. Local authority revocation
may discard the receipt because stale or uncertain authority forbids terminal
event publication, but it must still await successful termination and cleanup.

`absent` is not an error: cancellation may arrive before the sandbox exists or
race with already-finished cleanup. A later outcome arbiter will combine the
authenticated directive, receipt, execution-start latch, elapsed duration,
and runtime outcome. This slice does not itself create cancellation evidence.

This decision adds no session, elapsed-time clock, runtime execution,
publication call, polling loop, or runner enablement. It supplies the factual
termination result required before terminal outcome precedence can be defined.

Implementation commit `c7d5669` passed every local repository gate, including
436 runner-local tests and the low-severity dependency audit. Fifty-seven
focused backend, cancellation-scope, supervisor, and authority-monitor tests
prove exact receipt validation, graceful and forced termination, disappearance,
uncertainty, cleanup failure, natural-completion races, duplicate joining, and
receipt identity preservation. GitHub Actions run `30707452237` passed every
PostgreSQL, authenticated API, runner, Chromium product-journey, and production
build gate. Manual OCI reference-host run `30707705105` then passed the rootless
engine comparison, guarded production backend, and admitted task-runtime
validation on implementation commit `c7d5669`. Its new schema-version 3 backend
and schema-version 6 runtime evidence both record exact-fence cancellation as
`{ state: "terminated", forced: true }` with successful cleanup. This admits
ADR-068 and closes Slice 2.31; session composition, terminal outcome
arbitration, polling, and runner enablement remain disabled.

### ADR-069: Terminal outcome arbitration is a pure authority-first policy

Runtime completion, authenticated cancellation, and lease-authority loss can
settle near one another. Promise settlement order, local wall-clock order, and
exception arrival order are not durable facts and must not decide which
terminal event is published. The session will eventually observe these
concurrently, but the precedence policy must exist and be tested before any
session composes them.

One pure `TerminalOutcomeArbiter` therefore accepts only four closed facts: the
validated frozen execution identity, the durable execution-start latch with a
bounded elapsed duration only when started, one trusted terminal candidate, and
one sealed authority observation. A candidate is either a validated complete
runtime lifecycle batch, one runner-owned `task.failed` draft, or explicitly
absent. The authority observation is `stopped`, authenticated `cancelled` with
its exact termination receipt, `stale`, or redacted `uncertain`. It never
contains an exception, stack, host path, lease timestamp, or arbitrary reason.

Precedence is fixed. Stale or uncertain authority produces `no_evidence`
regardless of a local candidate. Authenticated cancellation with a
`terminated` receipt produces `task.cancelled` and uses the receipt's exact
`forced` value; termination without a durable execution start is an observation
conflict and produces no evidence. Authenticated cancellation with an `absent`
receipt preserves a complete runtime candidate because the cancellation did
not terminate that sandbox. Otherwise the authenticated directive produces a
non-forced cancellation, including cancellation before sandbox creation. A
clean owner-stopped monitor preserves its trusted runtime or local-failure
candidate. Owner stop without a candidate is incomplete and produces no
evidence.

Runtime candidates must pass the existing terminal-batch contract and may
contain intermediate evidence followed by exactly one terminal event. Local
failure candidates must contain exactly one `task.failed` draft; cancellation
drafts are created only inside the arbiter from an authenticated directive.
Every decision and nested value is frozen. `no_evidence` reasons are a closed,
redacted union and are not converted into another failure draft.

The arbiter performs no clock read, heartbeat, sandbox operation, journal or
spool mutation, network request, publication, completion, or retry. This slice
defines deterministic precedence only. Session composition, concurrent
execution, polling, and runner enablement remain disabled.

Implementation commit `ce9b2e9` passed every local repository gate, including
473 runner-local tests and the low-severity dependency audit. Thirty-seven
focused arbiter tests exhaustively cross runtime, local failure, and absent
candidates with stopped, absent-cancellation, graceful-cancellation,
forced-cancellation, stale, and uncertain authority. They also prove pre-start
contradictions, exact identity binding, duration bounds, strict shape rejection,
uncertainty redaction, deep immutability, and terminal-batch validation. The
receipt contract was separated into a pure OCI contract module so lifecycle
policy cannot reach the production backend adapter. GitHub Actions run
`30708344642` passed every PostgreSQL, authenticated API, runner, Linux native
durability, Chromium product-journey, and production-build gate. This admits
ADR-069 and closes Slice 2.32; session composition, side effects, polling, and
runner enablement remain disabled.

### ADR-070: Publication requires a serialized authority checkpoint

ADR-063 permits `LeaseAuthorityMonitor.stop()` only after terminal
acknowledgement and durable work completion. The first ADR-069 policy used
`stopped` as the clean-authority branch for a trusted candidate, but a future
session cannot obtain that observation before publication without violating
ADR-063. Treating an unresolved monitor Promise, a cached renewal, or local
lease-time comparison as equivalent authority would reintroduce race and clock
inference.

`LeaseAuthorityMonitor` therefore gains one explicit `checkpoint()` operation.
It never reads a clock and never grants a lease. It joins an already in-flight
heartbeat or interrupts only the scheduled wait so the monitor performs one
immediate serialized heartbeat. A successful authenticated renewal returns a
deeply frozen `renewed` checkpoint with the server lease-expiry value preserved
only as opaque evidence. Authenticated cancellation and stale results retain
their existing closed forms. Authority, scheduler, or revocation uncertainty
rejects through the existing bounded monitor error taxonomy.

Concurrent checkpoint callers join the same current or next heartbeat and
receive the same frozen result object. No checkpoint heartbeat may overlap the
cadence. A checkpoint requested before `start()` participates in the initial
immediate heartbeat. Cancellation, stale authority, or monitor uncertainty
settles the main monitor and every waiting checkpoint consistently. Explicit
owner stop never manufactures renewal: a checkpoint that cannot be served
before a sealed stop rejects with a fixed `monitor_stopped` error.

The terminal arbiter replaces its pre-publication `stopped` authority branch
with `renewed`. `stopped` is removed from arbiter input and remains solely the
post-completion monitor result defined by ADR-063. A renewed checkpoint
preserves a trusted runtime or local-failure candidate; renewal without a
candidate remains `no_evidence`. Cancellation, stale, uncertainty, receipt,
and contradiction precedence otherwise remain unchanged.

A checkpoint does not freeze future control-plane state. The future session
must keep the monitor running through durable local append, remote
acknowledgement, and work completion; event endpoints still enforce the exact
fence transactionally. Only after completion may the owner call `stop()`. This
slice adds no terminal publication, session composition, acquisition loop,
polling, or runner enablement.

Implementation commit `9636848` passed every local repository gate, including
26 focused lease-authority monitor tests, 39 focused terminal-arbiter tests,
485 runner-local tests, production builds, and the low-severity dependency
audit. The monitor tests prove checkpoint single-flight identity, immediate
wake-up without heartbeat overlap, terminal replay, stop races, scheduler
failure separation, and deep immutability. The arbiter tests prove that only an
authenticated renewed checkpoint can preserve trusted local evidence and that
the former stopped observation is rejected. GitHub Actions run `30709048533`
passed every PostgreSQL, authenticated API, runner, Linux native durability,
Chromium product-journey, and production-build gate. This admits ADR-070 and
closes Slice 2.33; terminal publication, session composition, polling, and
runner enablement remain disabled.

### ADR-071: Local attempt execution closes into one deterministic observation

A publication-owning one-shot session cannot yet be composed safely. If
terminal publication becomes uncertain after local append, ADR-063 forbids the
owner from stopping lease supervision before acknowledgement and durable work
completion. Returning while a detached monitor continues would orphan
authority ownership, while stopping it would weaken recovery. Session
composition therefore first requires a smaller closed boundary that performs
local work but neither observes authority nor publishes events.

`AttemptExecutionObserver` owns exactly one frozen execution attempt. Repeated
`observe()` calls join the same operation and receive the same deeply frozen
result. It prepares the source and image, crosses the durable execution-start
barrier immediately before sandbox invocation, executes the bounded runtime,
adapts valid runtime frames into terminal drafts, and releases every acquired
local capability before returning. It has no transport, spool, work-completion,
lease-supervision, or polling dependency.

The result contains only the ADR-069 arbitration inputs that can be known
locally: `TerminalExecutionTiming` and `TerminalOutcomeCandidate`. Successful
runtime evidence becomes a runtime candidate. A recognized local failure
becomes one safe `task.failed` candidate through `localFailureEvidence`.
Explicit authority-driven abort becomes `none`; cancellation, stale authority,
or uncertainty remains the future arbiter's decision. Unknown caught failures
after observation begins close to the redacted `unexpected_runner_failure`
policy rather than leaking messages or exception shapes.

Failure normalization is stage-aware and typed. Projection, artifact lookup,
artifact identity, image admission, source materialization, request
materialization, sandbox execution, runtime protocol, lifecycle adaptation,
and cleanup map to the existing closed local failure codes. Preparation and
runtime coordinators must wrap dependency failures at the boundary where their
stage is still known. Abort is recognized only from an exact signal reason or a
typed backend-aborted error; merely finding a signal aborted after another
failure is not enough to erase already-observed evidence.

`DurableExecutionTimingBarrier` wraps the existing durable start barrier and an
injected monotonic time source. It records a baseline only after the durable
barrier succeeds and before sandbox invocation. A snapshot before that point is
`not_started`; afterward it is `started` with a rounded-up non-negative safe
integer elapsed duration. Non-finite values, regression, overflow, or
time-source failure reject the shared observation with a typed
`timing_uncertain` error and do not manufacture terminal evidence. This clock
is used only for event duration; it never interprets lease timestamps or grants
authority.

Cleanup has precedence over an otherwise successful or failed runtime
candidate: if source, request, or sandbox cleanup cannot be proven, the local
observation becomes `cleanup_failed`. A preparation failure that already
attempted compensating cleanup follows the same rule. Returning an observation
proves that no prepared source or request capability remains owned by the
observer; sandbox cleanup remains a typed backend obligation.

This slice creates no executable runner entry point. The future session must
start lease supervision, await this local observation without using Promise
settlement order as policy, obtain the ADR-070 checkpoint, arbitrate through
ADR-069, and keep supervision owned through recoverable publication and durable
completion. Publication ownership, session composition, acquisition polling,
and runner enablement remain separate decisions.

Implementation commit `f750aa1` passed every local repository gate, including
13 focused observer tests, 11 focused durable-timing tests, the expanded
16-test preparation, 19-test runtime-executor, and 23-test OCI-backend suites,
516 runner-local tests, production builds, and the low-severity dependency
audit. The tests prove exact single-flight identity, stage redaction, exact
abort recognition, durable-start timing, nested uncertainty precedence,
prepared-identity binding, cleanup precedence, and deep immutability. GitHub
Actions run `30710103241` passed every PostgreSQL, authenticated API, runner,
Linux native durability, Chromium product-journey, and production-build gate.

Disposable OCI reference-host run `30710335532` independently passed the
rootless engine comparison, guarded production backend, and admitted task
runtime on the same commit. Its new backend schema-v3 and runtime schema-v6
evidence both record exact-fence termination as `terminated` and forced, plus
complete cleanup; runtime evidence additionally proves source release and the
same forced termination receipt through `RuntimeSandboxError`. This admits
ADR-071 and closes Slice 2.34. Authority ownership, terminal publication,
session composition, acquisition polling, and runner enablement remain
disabled.

### ADR-072: Publication failure must expose a durable disposition

A future session cannot decide whether to retain, stop, or abandon lease
supervision from a thrown publication exception alone. The same transport or
filesystem rejection can occur before a terminal batch exists, after its commit
is durable, after the control plane acknowledged every event, or after durable
work completion committed but before the caller observed success. Retrying
blindly risks duplicate side effects; stopping blindly can strand committed
evidence; keeping the monitor forever can prevent lease-expiry reconciliation.

`TerminalEvidencePublicationCoordinator` therefore audits durable state after
every dependency failure at one of three fixed boundaries:
`recovery_before_append`, `append`, or `recovery_after_append`. The audit is
read-only. It validates the exact delivery, execution digest, attempt identity,
work-journal state, spool attempt key, terminal marker, acknowledgement cursor,
last sequence, and pending count. It cannot append, send, acknowledge, complete,
retry, consult a lease clock, or invoke authority supervision.

The resulting deeply frozen `TerminalPublicationDisposition` is one of:

- `absent`: active claimed or execution-started work has no committed terminal
  batch; a manifest-only empty spool is equivalent to no batch;
- `pending`: one committed terminal batch has at least one unacknowledged event,
  with exact acknowledged, last, and pending counters;
- `acknowledged`: the complete terminal batch is durably acknowledged but work
  completion is not yet durable;
- `completed`: work completion is durable and the spool retains the matching
  complete terminal acknowledgement.

Impossible combinations are not coerced. Completed work without the matching
terminal acknowledgement, non-terminal non-empty evidence, counter drift,
identity mismatch, retired or rejected work, or an audit dependency failure
reject as a frozen `publication_state_uncertain` error that retains the same
fixed failure boundary. No guessed disposition is returned.
Invalid caller input and pre-existing identity or work-state conflicts retain
their current fixed errors and do not enter deferred recovery policy.

If a dependency failed but the audit proves `completed`, publication returns a
normal recovered completion because the durable postcondition outranks the
lost response. Otherwise it throws one redacted
`TerminalEvidencePublicationDeferredError` containing only the fixed boundary
and frozen disposition; the original cause remains in memory through
`Error.cause`. Concurrent publication calls remain serialized, and auditing a
failure cannot create a second append or drain.

This disposition is evidence for a later ownership decision, not that decision
itself. A future publication owner may retry `pending` or `acknowledged` while
authority remains owned, may stop only after `completed`, and must use a
separately designed fail-stop abandonment path for fatal `absent` publication.
This slice adds no retry scheduler, monitor abandonment, reconciliation-order
change, session composition, acquisition polling, or runner enablement.

Implementation commit `2066567` passed every local repository gate, including
22 disposition-auditor tests, 24 publication-coordinator tests, all 544
runner-local tests, production builds, and the dependency audit. These tests
prove the four exact frozen dispositions, all three fixed failure boundaries,
lost-completion recovery, redacted and immutable deferred/uncertain errors,
serialized duplicates, impossible-state rejection, and read-only inspection of
real durable journal/spool state without a second append.

GitHub Actions run `30711001656` passed every PostgreSQL, authenticated API,
runner integration, Linux native spool/work-journal durability, Chromium
product-journey, production-build, and evidence-upload gate. This admits
ADR-072 and closes Slice 2.35. Publication retry, monitor abandonment,
reconciliation order, session composition, acquisition polling, and runner
enablement remain disabled pending their own architecture decision.

### ADR-073: Lease release distinguishes completion from publication abandonment

`LeaseAuthorityMonitor.stop()` currently means only that its owner no longer
wants another heartbeat. That physical effect is insufficient for a future
attempt session: stopping after durable work completion is a clean release,
while ceasing renewal because terminal publication cannot safely continue is a
fail-stop abandonment. Treating both as `stopped` would let callers and tests
mistake missing terminal evidence for successful ownership closure.

The monitor will therefore expose one explicit publication-abandonment request
in addition to clean `stop()`. Clean release settles as `stopped`; abandonment
settles as a deeply frozen `abandoned` result with the fixed redacted reason
`terminal_publication_failed`. A checkpoint after abandonment rejects with the
fixed code `monitor_abandoned`. No dependency message, path, event, or durable
payload enters either result.

Owner release never pretends to revoke control-plane authority. It prevents a
new heartbeat, wakes a scheduled wait, and lets an already in-flight heartbeat
settle. If that heartbeat reports cancellation, stale authority, or
uncertainty, the authenticated or safety-critical outcome outranks the owner
release request. If it renews, the monitor returns the already selected clean
or abandoned release without scheduling another heartbeat. The first clean or
abandon request wins, every caller joins the same terminal monitor promise, and
neither path invokes local sandbox revocation: ADR-071 has already made closed
observation and cleanup a prerequisite for publication ownership.
Scheduler abort handling recognizes only the monitor's exact private
`AbortSignal.reason`; an unrelated scheduler rejection that settles beside a
release remains `scheduler_failed` and cannot be masked as owner release.

A separate pure `TerminalPublicationAuthorityPolicy` maps an explicit
`fulfilled` or `rejected` publication settlement without performing effects.
It never observes Promise settlement order and does not retain the fulfilled
work value or rejected reason in its decision:

- durable `completed` publication selects clean `stop`;
- deferred `pending` or `acknowledged` publication selects `retain` so a later
  owner can recover while supervision remains live;
- deferred `absent`, publication-state uncertainty, or any other fatal
  publication failure selects `abandon`;
- a deferred `completed` disposition is rejected as an impossible input because
  ADR-072 converts that state into normal recovered success.

The policy does not call the monitor, retry publication, reconcile a lease, or
race promises. This slice adds the semantic primitive needed by a later
publication owner; it does not add that owner, a retry scheduler, session
composition, acquisition polling, or runner enablement.

Implementation commit `59341f8` passed every local repository gate, including
34 lease-authority-monitor tests, 21 publication-authority-policy tests, all 573
runner-local tests, production builds, and the dependency audit. These tests
prove first-wins clean/abandoned release, exact scheduler-wake identity,
cancellation/stale/uncertainty/revocation precedence, no release-time sandbox
revocation, exhaustive settlement mapping, fail-closed malformed input,
redaction, and immutable decisions.

GitHub Actions run `30711742434` passed every PostgreSQL, authenticated API,
runner integration, Linux native spool/work-journal durability, Chromium
product-journey, production-build, and evidence-upload gate. This admits
ADR-073 and closes Slice 2.36. Publication retry/recovery ownership,
reconciliation order, session composition, acquisition polling, and runner
enablement remain disabled pending their own architecture decision.

### ADR-074: Terminal publication has one bounded authority owner

ADR-072 can report durable `pending` or `acknowledged` evidence, and ADR-073 can
decide to retain lease supervision, but no component yet owns the next action.
A future session must not catch a deferred publication error and create an
unbounded retry loop, retry pending network effects without renewed authority,
or stop the monitor merely because one recovery attempt failed.

One one-shot `TerminalPublicationOwner` will own publication settlement and
lease release after the session has already selected terminal evidence. Its
publication operation is fixed at construction and `complete()` is
single-flight: concurrent and later callers receive the same Promise and
cannot create an independent retry or release decision. A bounded configuration
sets zero to one hundred recovery retries; the initial publication attempt is
not counted as a retry. There is no hidden default, timer, delay, wall clock, or
infinite mode.

Every attempt is classified by ADR-073's pure policy. The owner then follows
one exact path:

- completed publication requests clean monitor stop and returns the durable
  publication together with the actual `stopped`, `cancelled`, or `stale`
  monitor result;
- deferred `acknowledged` evidence retries publication immediately because
  ADR-065 recovery can only inspect the spool and commit local completion;
- deferred `pending` evidence obtains a fresh ADR-070 monitor checkpoint before
  each retry, and retries only after `renewed`;
- deferred `absent`, publication-state uncertainty, and every other fatal
  publication failure request ADR-073 abandonment immediately;
- exhausting the configured recovery count while evidence remains pending or
  acknowledged also requests abandonment.

Across retained failures, the owner pins delivery/task/attempt identity,
terminal `lastSequence`, and the first observed cursor. Later acknowledgement
may advance and pending count may fall by the exact inverse delta; neither may
regress, and an acknowledged disposition cannot become pending again. Identity,
terminal-length, or cursor drift is `disposition_regressed` and selects
abandonment rather than another retry.

Cancellation or stale authority returned by a pending-retry checkpoint ends
ownership without another publication call or a competing abandonment request;
the monitor already has an authenticated terminal result. Checkpoint
uncertainty similarly ends the operation without masking or replacing the
monitor failure. Restart handling of the retained spool remains a later
reconciliation-order decision.

Clean stop can race an already in-flight heartbeat. Durable publication remains
completed when stop returns `cancelled` or `stale`; the exact monitor result is
retained in the frozen success. A stop rejection is instead
`completion_release_uncertain` and retains the proven completion only in memory.
An `abandoned` result from a clean-stop request, or `stopped` from an abandonment
request, is an ownership conflict because some other caller selected release
first. Abandonment failure retains both publication and monitor causes only in
an `AggregateError`. All public messages are fixed and redacted.
Malformed checkpoint or monitor-release results never satisfy a success path:
they fail closed as checkpoint uncertainty or release conflict.

This owner composes only existing publication, checkpoint, clean-stop, and
abandonment ports. It does not start a monitor, observe or arbitrate execution,
reconcile restart state, schedule delays, acquire work, poll, or enable a runner
entry point. Full attempt-session composition remains a later decision.

Implementation commit `57a7bb9` passed every local repository gate, including
45 publication-owner tests, 100 combined owner/policy/monitor tests, all 618
runner-local tests, production builds, and the dependency audit. These tests
prove exact zero-to-one-hundred retry bounds, checkpointed pending recovery,
local acknowledged recovery, monotonic cursor/identity pinning, authority
terminal precedence, clean-stop and abandonment races, malformed-port
fail-closed behavior, single-flight success and failure replay, mutation
resistance, and redaction.

GitHub Actions run `30712598503` passed every PostgreSQL, authenticated API,
runner integration, Linux native spool/work-journal durability, Chromium
product-journey, production-build, and evidence-upload gate. This admits
ADR-074 and closes Slice 2.37. Restart reconciliation order, attempt-session
composition, acquisition polling, and runner enablement remain disabled pending
their own architecture decision.

### ADR-075: Restart triage separates local completion from authority-bound replay

ADR-065 and ADR-066 recover terminal evidence before attempt reconciliation.
That ordering was sufficient while no live session could be composed, but it is
too coarse for production enablement. Fully acknowledged evidence needs only a
local journal completion and is safe before reconciliation. Pending evidence can
still require a control-plane event write and must not be replayed by a restarted
process that has not re-established current lease authority. Recovered `claimed`
work has the same gap: returning it as ready without reconciliation can start an
attempt from an expired or superseded lease.

`WorkAdmissionCoordinator` will therefore receive both the read-only ADR-072
disposition auditor and the existing ADR-065 recovery operation. For recovered
`claimed` and `execution_started` work it audits first, before sender,
completion, reconciliation mutation, acquisition, or execution release:

- `completed` returns the existing completed admission result;
- `acknowledged` invokes bounded recovery, which sends zero events and must
  durably complete the local journal before admission returns completed;
- `pending` reconciles the exact attempt before any sender call;
- `absent` follows state-specific reconciliation with no recovery call.

For pending evidence, a `current` reconciliation returns a new frozen
`recovery_pending` admission result containing the exact delivery, execution,
work, observed time, and lease expiry. It performs no replay. A later session
must start lease supervision and hand the fixed recovery publication to ADR-074.
A `retired` reconciliation durably retires the local work with the authoritative
reason and leaves spool bytes untouched for diagnostics; it does not attempt an
unauthorized replay.

Recovered claimed work with absent evidence also reconciles. Current authority
returns the existing ready result; retired authority commits retirement and
cannot execute. Fresh work claimed in the same serialized admission call remains
ready without a redundant reconciliation because that claim transaction just
created the exact lease. Execution-started absent evidence preserves the current
indeterminate/retired behavior.

An acknowledged disposition followed by recovery `none`, non-completed output,
identity drift, or work-state drift is `terminal_recovery_inconsistent` and
fails closed. Audit, recovery, and reconciliation exceptions remain unchanged
in memory and suppress same-call acquisition. The coordinator stays serialized,
and no path can call both terminal sender recovery and reconciliation for one
prepare operation.

ADR-075 supersedes only the restart ordering paragraphs of ADR-065 and ADR-066;
their durable replay, exact acknowledgement, and completion invariants remain
unchanged. This slice adds no monitor construction, publication owner wiring,
attempt session, polling loop, or runner enablement.

Implementation commit `f69c2af` passed every locally applicable repository
gate, including 41 restart-triage tests, all 659 runner-local tests, production
builds, and the dependency audit. The focused matrix proves claimed/started
ordering across absent, pending, acknowledged, and completed evidence; every
authoritative retirement reason; exact no-replay/no-reconcile boundaries;
fail-closed identity, state, cursor, and recovery validation; frozen handoff;
and acknowledged and pending behavior through restarted durable journal/spool
stores.

GitHub Actions run `30713739060` passed every PostgreSQL, authenticated API,
runner integration, Linux native spool/work-journal durability, Chromium
product-journey, production-build, and evidence-upload gate. This admits
ADR-075 and closes Slice 2.38. Attempt-session composition, monitor startup,
acquisition polling, and runner enablement remain disabled pending their own
architecture decision.

### ADR-076: Restart recovery publication has no append authority

ADR-075 exposes current pending evidence as `recovery_pending`, but the normal
ADR-067 publication operation still accepts fresh terminal drafts and owns an
append port. Passing placeholder drafts to that operation would be unsafe: if
the durable spool disappeared or was misread between admission and session
startup, recovery could cross into a new append and manufacture different
terminal evidence. A type-level promise to call recovery first is not enough;
the restart handoff must be incapable of appending.

One `RecoveryOnlyTerminalPublication` will therefore bind the exact frozen
active work, delivery, and execution from ADR-075 to the existing durable
recovery operation and read-only ADR-072 auditor. The bound work must be
`claimed` or `execution_started`; an audited active disposition must preserve
its full identity and state snapshot, while a completed disposition may add
only the matching durable completion. It receives no drafts and no appender
capability. Each serialized `publish()` call may drain only the already-existing
terminal spool and either return the standard frozen
`{ state: "completed", publication: "recovered" }` result or fail closed. It is
repeatable rather than single-flight because the ADR-074 owner must be able to
retry a retained disposition; ADR-074 remains the single owner of retry count,
authority checkpoints, and terminal release.

Every invocation audits before recovery. Audited `completed` evidence returns
recovered success without probing; audited `absent` is a fixed
`recovery_evidence_missing` failure; only `pending` or `acknowledged` may call
recovery. A completed recovery result is then audited again and must preserve
delivery, task, attempt, execution, attempt key, acknowledgement cursor, and
completed work identity. Recovery `none`, malformed output, or contradictory
post-recovery state is `recovery_result_inconsistent` and can never fall
through to append.

If recovery rejects, the operation audits again at the new `recovery_only`
failure boundary. Audited `completed` evidence converts ambiguity into
recovered success. Audited `pending` or `acknowledged` evidence throws the
existing frozen `TerminalEvidencePublicationDeferredError`, allowing ADR-074
to retain authority and apply its pending-checkpoint or acknowledged-local
retry rule. Audited `absent` is missing evidence. Initial or post-failure audit
uncertainty throws `TerminalEvidencePublicationStateUncertainError`; when a
primary recovery failure exists, both causes remain only in memory. All public
messages remain fixed and redacted.

This primitive does not itself establish authority. A future attempt session
may construct it only from ADR-075 `recovery_pending`, start the exact lease
monitor, and hand its fixed zero-argument operation to ADR-074. This slice adds
no monitor construction, execution observer, terminal arbitration, fresh
publication, acquisition polling, or runner enablement.

Implementation commit `9559f45` adds the append-free recovery publication
primitive, extracts strict shared terminal-evidence consistency validation,
and proves compatibility with the standard ADR-074 bounded publication owner
without granting draft or append capabilities. Thirty-seven focused tests cover constructor and
identity validation, malformed and drifting evidence, audit/recovery ordering,
pending and acknowledged retry ownership, immutable repeatable results, and
real restarted journal/spool states that prove absent evidence stays absent and
pending recovery sends only the already-durable event. All 696 runner-local
tests and every local repository gate passed, including the PostgreSQL-backed
Chromium measured-research journey.

GitHub Actions run `30715071832` passed every PostgreSQL migration, seed,
database/API/runner integration, Linux native spool/work-journal durability,
Chromium product-journey, production-build, and evidence-upload gate. This
admits ADR-076 and closes Slice 2.39. Monitor construction, attempt-session
composition, acquisition polling, and runner enablement remain disabled
pending their own architecture decision.

### ADR-077: Restart terminal recovery has one closed session owner

ADR-075 can now return an exact `recovery_pending` handoff, and ADR-076 can
settle its existing spool without append authority. Calling that publication
operation directly would still leave lease supervision outside the ownership
boundary. A caller could start recovery before the heartbeat monitor, fail to
observe a rejected monitor Promise, bind cancellation to another execution, or
return while authority remained active. Wiring independent objects in a future
polling loop would make those ordering errors production-reachable.

One `RestartTerminalRecoverySession` will therefore accept only an exact,
deeply frozen ADR-075 `recovery_pending` handoff and construct all identity-
bound collaborators itself. It creates the cancellation scope for the handed-
off execution, the heartbeat-only lease supervisor, the ADR-073 authority
monitor, the ADR-076 recovery-only publication, and the ADR-074 bounded owner.
Its dependency surface contains a heartbeat capability, sandbox cancellation
backend, abort-aware authority scheduler, terminal disposition auditor, and
terminal recovery port. It receives no event drafts, append port, event ID
source, wall clock, execution observer, or acquisition capability.

`settle()` is single-flight. It starts the authority monitor before invoking
the publication owner and immediately observes both Promises. The initial
heartbeat may remain in flight while the recovery-only operation audits
durable evidence; remote event submission remains fenced transactionally, and
the owner requires a fresh serialized checkpoint before every retained
`pending` retry. An `acknowledged` retry remains local and requires no extra
heartbeat. The session does not interpret the reconciliation timestamps as
authority and never compares a local clock with them.

The session awaits both ownership and monitor settlement without using
Promise settlement order as policy. A successful ownership result must contain
the same terminal authority result produced by the monitor. Every owner error
path must already have either abandoned the monitor or observed its terminal
cancelled, stale, or uncertain result. Contradictory fulfilled results,
unexpected detached authority, malformed handoff state, or identity drift fail
closed through a fixed session error while retaining causes only in memory.
No clean return may leave a scheduled or in-flight heartbeat owned by the
session.

This session handles only restart recovery of already-durable terminal
evidence. It does not execute a sandbox, arbitrate new outcomes, create fresh
terminal evidence, admit another task, run the startup barrier, poll, back off,
or enable the runner. Fresh `ready` work and recovered `claimed` work still
require the later full attempt session; runner startup must still complete the
ADR-057 owned-resource barrier before admission can produce this handoff.

Implementation commit `a49fb60` adds the closed restart recovery session,
narrows lease supervision to a heartbeat-only control-plane capability, and
starts the first serialized heartbeat before any publication audit effect.
Thirty-one focused session tests cover strict handoff validation, construction
without effects, exact identity binding, pending checkpoints, acknowledged
local retry, cancellation, stale and uncertain authority, scheduler and
revocation failures, bounded exhaustion, in-flight heartbeat release,
single-flight settlement, immutable inputs, and redacted failures. Real
restarted journal/spool cases prove pending recovery submits only its existing
event and acknowledged recovery completes without submitting one.

All 727 runner-local tests and every locally applicable repository gate passed,
including the PostgreSQL-backed Chromium measured-research journey. GitHub
Actions run `30716554709` passed every PostgreSQL migration, seed,
database/API/runner integration, Linux native spool/work-journal durability,
Chromium product-journey, production-build, and evidence-upload gate. This
admits ADR-077 and closes Slice 2.40. Fresh attempt execution, startup
orchestration, acquisition polling, and runner enablement remain disabled.

### ADR-078: No-evidence closure is neither completion nor publication abandonment

The future fresh attempt session must arbitrate an ADR-071 local observation
against an ADR-070 authority checkpoint. ADR-069 may legitimately return
`no_evidence`: authority can be stale or uncertain, a trusted candidate can be
missing, or execution timing can contradict the candidate. Once the observer
has released its source, request, and sandbox capabilities, the session still
owns the authority monitor. ADR-073 `stop()` is forbidden because no terminal
acknowledgement or durable work completion exists. ADR-073
`abandonPublication()` is also false because no publication may have started.
Leaving the monitor detached is not an option.

`LeaseAuthorityMonitor` will therefore gain one distinct
`releaseWithoutEvidence()` owner operation. It records the first release intent
and returns the closed result
`{ state: "released", reason: "terminal_evidence_unavailable" }` only after any
in-flight heartbeat has settled as renewed. It aborts a scheduled wait and
sends no new heartbeat. An authenticated cancellation or stale response from
an in-flight heartbeat outranks release and returns its existing terminal
result. Heartbeat, scheduler, or revocation uncertainty keeps the existing
fail-stop rejection and local revocation behavior; it is never converted into
a clean release.

Evidence-free release performs no sandbox cancellation of its own because the
future caller may invoke it only after ADR-071 observation has closed and
released every local capability. It does not mutate the work journal, retire an
attempt, complete work, notify the control plane, emit an event, or infer lease
expiry from a clock. The active durable work remains for ADR-075 restart
triage; stopping renewals merely permits the control plane to classify it
authoritatively later.

The new result is not accepted as clean completion or publication abandonment.
ADR-074 retains its exact result sets, so seeing `released` through `stop()`,
`abandonPublication()`, or a publication checkpoint remains a release conflict.
`checkpoint()` after evidence-free release rejects with fixed
`monitor_released`. A checkpoint already joined to an in-flight heartbeat
settles from that heartbeat before release can complete; a queued checkpoint
that cannot begin before release is sealed rejects with the same fixed error.
The first owner release intent remains final and repeatable across later calls.

This slice defines only the missing authority terminal state and its ownership
invariants. It does not call the arbiter, construct a fresh attempt session,
execute a sandbox, append evidence, mutate admission, poll, back off, or enable
the runner. The later session may select this release only from an exact frozen
ADR-069 `no_evidence` decision after local observation cleanup.

Implementation commit `f716f67` adds the distinct immutable release result,
the first-intent `releaseWithoutEvidence()` monitor transition, and the fixed
post-release checkpoint error. ADR-074 completion is narrowed to the exact
stopped, cancelled, and stale result set, so a released monitor cannot become
successful completion or publication abandonment through a widened union.
Fifteen focused tests cover pre-start and scheduled release, in-flight renewal,
cancellation, stale authority, heartbeat/scheduler/revocation uncertainty,
checkpoint ordering, competing owner intents, already-terminal monitors, deep
immutability, redacted errors, and all three publication-owner conflict paths.

All 744 runner-local tests and every locally applicable repository gate passed
against a fresh PostgreSQL database, including the Chromium measured-research
journey and production build. GitHub Actions run `30717770398` passed every
format, type, lint, Phase 1/2 boundary, PostgreSQL migration/seed,
workspace/database/API/runner integration, Linux native spool/work-journal
durability, Chromium product-journey, production-build, and evidence-upload
gate. This admits ADR-078 and closes Slice 2.41. Outcome arbitration, fresh
attempt-session composition, polling, and runner enablement remain disabled.

### ADR-079: Local timing uncertainty is a closed arbitration fact

ADR-071 normally resolves one local attempt into timing plus a trusted terminal
candidate, but it currently rejects when the injected monotonic time source is
unavailable, non-finite, regresses, or overflows. A future fresh attempt
session cannot safely propagate that rejection. Publication would be
untruthful because elapsed execution timing is unknown, while ADR-078 permits
evidence-free authority release only after an exact frozen ADR-069
`no_evidence` decision. Stopping or abandoning the monitor would assign false
completion or publication meaning, and detaching it would orphan authority.

`TerminalExecutionTiming` will therefore gain one exact redacted state:
`{ state: "uncertain", boundary: "monotonic_time" }`. ADR-071 will resolve,
rather than reject, its shared observation with that state only when an exact
nested `DurableExecutionTimingBarrierError` proves `timing_uncertain`. It still
awaits request, sandbox, source, and compensating cleanup ownership before
settlement. Arbitrary dependency errors remain subject to the existing typed
stage normalization and cannot disguise themselves as timing uncertainty. No
exception, time value, path, or dependency message enters the observation.

ADR-069 will strictly parse the new timing state and add the closed
`observation_uncertain` no-evidence reason. It continues to validate the full
candidate and authority shapes before deciding. Stale and uncertain authority
retain authority-first precedence. An authenticated cancellation must still
match the frozen execution identity even when local timing is uncertain; after
that validation, timing uncertainty suppresses renewed or cancelled evidence
because neither a truthful duration nor a durable pre-start classification can
be proven. It never becomes `task.failed`, `task.cancelled`, or a zero-duration
guess.

Normal `not_started` and `started` behavior is unchanged. The observer remains
single-flight and side-effect closed, while the arbiter remains pure. This
slice does not construct an authority monitor, call ADR-078 release, publish an
event, compose a fresh session, poll, back off, or enable the runner. It only
creates the last closed local fact required for every observation settlement
to reach deterministic arbitration.

Implementation commit `f521a45` adds the exact frozen `monotonic_time`
uncertainty state, resolves typed observer timing failures only after local
cleanup settlement, and adds strict `observation_uncertain` arbitration. The
observer no longer exports a timing-rejection type. The arbiter validates the
complete candidate and authenticated cancellation identity before local
uncertainty suppression, while stale and uncertain authority retain their
authority-first result. Fifteen focused tests cover crossing and final-snapshot
uncertainty, cleanup precedence, single-flight resolution, lookalike errors,
all candidate/authority combinations, malformed hidden inputs, identity drift,
deep immutability, and redaction.

All 759 runner-local tests and every locally applicable repository gate passed
against a fresh PostgreSQL database, including the Chromium measured-research
journey and production build. GitHub Actions run `30718820150` passed every
format, type, lint, Phase 1/2 boundary, PostgreSQL migration/seed,
workspace/database/API/runner integration, Linux native spool/work-journal
durability, Chromium product-journey, production-build, and evidence-upload
gate. This admits ADR-079 and closes Slice 2.42. Authority/session composition,
publication wiring, polling, and runner enablement remain disabled.

### ADR-080: Fresh execution and publication have one closed session owner

An exact ADR-075 `ready` handoff now has every prerequisite required for one
attempt: closed local observation, serialized authority checkpoints, pure
outcome arbitration, durable publication with bounded recovery, explicit
evidence-free release, and total timing-uncertainty classification. Leaving
these as calls for a future polling loop would still permit execution before
heartbeat startup, publication from cached authority, cancellation bound to a
different sandbox scope, or a return while the monitor remains active.

One `FreshAttemptSession` will therefore accept only an exact deeply frozen
`ready` handoff and construct every execution-bound collaborator itself. The
same frozen execution binds one `SandboxCancellationScope`, heartbeat-only
`LeaseSupervisor`, `LeaseAuthorityMonitor`, durable execution-start and timing
barriers, execution projector, preparation coordinator, runtime executor,
attempt observer, terminal arbiter, publication coordinator, and bounded
publication owner. The ready handoff may be fresh or a safely reconciled
claimed restart, but its delivery and execution identities cannot drift.

`settle()` is single-flight. It starts and observes the authority monitor before
the observer may resolve source, image, request, or sandbox capabilities. The
observer then runs to its closed ADR-071/079 result and releases local ownership.
Only afterward does the session request one serialized ADR-070 checkpoint and
pass that exact authority fact with the local observation to ADR-069. A renewed
checkpoint is not cached permission: the monitor continues through append,
remote acknowledgement, local completion, and owner release.

An `evidence` decision constructs one fresh-publication operation with only the
decided drafts and gives it to ADR-074. The session awaits both publication
ownership and the already-observed monitor Promise. Success requires the
owner's stopped, cancelled, or stale authority result to equal the monitor's
terminal result exactly. Owner failure is returned only after authority has
also settled through abandonment, cancellation, stale authority, or existing
fail-stop uncertainty. Promise settlement order is never policy.

A `no_evidence` decision never constructs or invokes publication. The session
calls ADR-078 `releaseWithoutEvidence()` only with that exact frozen decision
and awaits the original monitor operation. It may return a frozen no-evidence
result only with `released`, authenticated `cancelled`, or `stale` authority.
Renewed authority must close as `terminal_evidence_unavailable`; an in-flight
cancellation or stale response keeps precedence. Heartbeat, scheduler, or
revocation uncertainty rejects through a fixed session boundary after the
monitor has completed its existing fail-stop revocation path.

The composition accepts narrow capabilities rather than a prebuilt observer,
monitor, arbiter, or publisher. One sandbox backend supplies both execution and
exact-identity cancellation. One journal capability supplies durable start and
publication identity. Publication receives the same spool and recovery ports
used by its disposition policy. Configuration bounds remain validated by their
own admitted components. Construction performs no heartbeat, filesystem,
network, clock, journal, or sandbox effect.

This slice composes one already-admitted attempt only. It does not open durable
stores, run the ADR-057 startup barrier, acquire work, interpret lease
timestamps, retry a session, poll, back off, schedule concurrency, or enable a
runner entry point. Those root lifecycle decisions remain separate after the
one-attempt ownership boundary is proven closed.

Implementation commit `95d11c3` adds the exact ready-handoff parser, shared
authority-settlement equality, and one `FreshAttemptSession` that constructs
the cancellation, heartbeat, execution, observation, arbitration, and
publication collaborators from narrow capabilities. Recovery bounds are
validated during construction. Authority begins before the first preparation
effect, the checkpoint follows observer cleanup, and publication is allocated
only for an evidence decision. A no-evidence decision performs only ADR-078
release. An unexpected observer rejection also awaits evidence-free monitor
closure before returning a fixed consistency error, so no internal error can
detach heartbeat ownership.

Twenty-three focused session tests cover fresh and recovered handoffs,
construction without effects, authority-first ordering, success and
cancellation publication, start and timing uncertainty, pre-execution
cancellation, stale and uncertain authority, recovered evidence, publication
abandonment, single-flight settlement, strict handoff rejection, bounded
configuration, immutable results, and evidence-free isolation. Real local
journal, spool, sender, and completion tests prove successful evidence is
durably appended, acknowledged, completed, and replayed without another event
ID or send; the real no-evidence path allocates no event ID, creates no spool,
and leaves active journal work for restart triage.

All 782 runner-local tests and every local repository gate passed against the
fresh `socrates_ci_adr080` PostgreSQL database, including the Chromium
measured-research journey and production build. GitHub Actions run
`30720392087` passed every format, type, lint, Phase 1/2 boundary,
PostgreSQL migration/seed, workspace/database/API/runner integration, Linux
native spool/work-journal durability, Chromium product-journey,
production-build, and evidence-upload gate. This admits ADR-080 and closes
Slice 2.43. Startup ownership, acquisition, polling, concurrency scheduling,
and runner enablement remain disabled.

### ADR-081: Startup recovery gates one serialized attempt dispatcher

ADR-057 proves stale exact-owned sandboxes and source trees can be removed
once, but the admitted barrier remains detached from ADR-075 work admission
and ADR-077/080 session ownership. A future polling loop must not be the first
caller to invent this ordering. It could construct store, admission, or
session services before recovery succeeds, acquire a second delivery while a
first attempt still owns resources, retry an uncertain failure in-process, or
route `recovery_pending` work through fresh execution.

One `StartupGatedAttemptDispatcher` will therefore own the process-local
ordering boundary without becoming a process entry point. Its constructor
accepts only one `RunnerStartupRecoveryBarrier` and one deferred composition
factory. Construction has no effects. The first `dispatchNext()` call awaits
the exact shared startup result before invoking that factory. The factory may
then open and bind durable stores, work admission, and session factories to
the already-recovered sandbox/source owners; it is never invoked after a
failed or partially successful startup barrier. Startup and composition
success or failure are retained for the lifetime of the dispatcher.

The post-recovery composition exposes one admission operation plus two narrow
session constructors. One constructor accepts only ADR-075 `ready` and owns an
ADR-080 fresh session. The other accepts only `recovery_pending` and owns an
ADR-077 restart publication session. The dispatcher calls `prepareNext()` at
most once per explicit dispatch and routes its exact immutable result:

- `ready` constructs and fully settles only the fresh session;
- `recovery_pending` constructs and fully settles only the restart session;
- `idle`, `rejected`, `indeterminate`, `retired`, and `completed` construct no
  session and return their admitted state unchanged.

The dispatcher serializes the entire operation, not only admission. A second
explicit dispatch cannot inspect the journal or acquire work until the first
fresh/recovery session has closed local capabilities, authority, and
publication. Concurrent callers queue in call order and receive distinct
dispatch results; they are not coalesced into one attempt. An optional signal
is forwarded only to admission. Once a session handoff exists, cancellation
authority remains the server-authenticated ADR-072 scope and cannot be
replaced by a caller abort.

Any startup, composition, admission, session-construction, or session-
settlement rejection permanently poisons this dispatcher. The first fixed
failure is retained and replayed to later callers without another cleanup,
compose, admission, heartbeat, session, or publication effect. Recovery from
an external condition requires a new process with fresh owners, matching
ADR-057. Successful terminal or no-evidence dispatches do not poison the
dispatcher; a later explicit call may let ADR-075 triage the remaining durable
work before acquiring anything new.

Successful session dispatch returns one deeply immutable wrapper naming
`fresh` or `restart_recovery`, the exact delivery/execution identity, and the
already-admitted session result. Non-session admissions remain deeply frozen
and are never reinterpreted. The dispatcher does not inspect lease timestamps,
invent terminal evidence, open stores itself, allocate event IDs, choose a
poll interval, sleep, back off, retry, schedule concurrency, install signal
handlers, read environment configuration, or enable `LocalRunner`. Concrete
process composition and any repeated polling lifecycle remain later,
independent decisions.

Evidence: architecture commit `4a2a520` preceded production code.
Implementation commit `f805358` added the deferred-composition dispatcher,
strict result contracts, and 42 focused ordering, routing, identity,
immutability, mutation, and fail-stop tests. All 824 runner-local tests and
every local repository gate passed against fresh migrated PostgreSQL database
`socrates_ci_adr081`, including the Chromium measured-research journey and
production build. Main CI run `30721734779` passed all PostgreSQL, API,
runner, Linux native durability, Chromium product-journey, production-build,
and evidence-upload gates. This admits ADR-081 and closes Slice 2.44. Concrete
process composition, timers, polling, backoff, concurrency scheduling, and
runner enablement remain separate decisions.

### ADR-082: One recovery-bound owner composes the local attempt graph

ADR-081 orders startup recovery before deferred composition, but its two
constructor arguments can still be assembled incorrectly by a future process
root. A barrier could recover one sandbox or source owner while the deferred
factory gives sessions a different instance. The journal, spool, sender,
completion, recovery, disposition, admission, and session graph can likewise
be duplicated or partially constructed before recovery. Correct individual
classes do not make a miswired object graph safe.

One effect-free `LocalAttemptOwner` will therefore become the only concrete
assembly boundary for explicit local attempt dispatch. Its constructor accepts
the exact sandbox and source owners, narrow control-plane and preparation
ports, immutable execution/storage policy, and no environment reader. It
constructs one ADR-057 barrier and one ADR-081 dispatcher internally. The same
captured sandbox object is used for owned-sandbox recovery, runtime execution,
cancellation, and both session paths; the same captured source object is used
for owned-source recovery, materialization, and release. Callers cannot supply
a separately constructed barrier or composition factory.

Construction validates and snapshots bounded configuration but performs no
filesystem, network, process, recovery, admission, scheduler, or timer effect.
The first explicit `dispatchNext()` delegates to ADR-081. Only after the shared
startup barrier succeeds does a private deferred factory open exactly one
`LocalWorkJournal` followed by exactly one `LocalEventSpool`. Their resolved
roots must be distinct and non-overlapping. A store-open failure exposes no
composition and inherits ADR-081 fail-stop behavior; uncertain filesystem
state is not deleted or retried in-process and must be inspected by a fresh
process.

The post-open graph shares those exact store instances. It binds one
`SequentialSpoolSender`, one `WorkCompletionCoordinator`, one
`TerminalEvidenceRecoveryCoordinator`, one
`TerminalPublicationDispositionAuditor`, and one `WorkAdmissionCoordinator`.
The auditor and recovery coordinator form the admission terminal-evidence
port. Fresh session factories receive the same journal, spool, recovery,
sandbox, source, control-plane, scheduler, time source, preparation ports, and
frozen policy. Restart session factories receive the same auditor, recovery,
sandbox, control-plane, scheduler, and frozen timing/retry policy. Dependency
methods are captured into narrow facades during effect-free construction so
later property mutation cannot redirect authority, persistence, execution, or
transport.

Every duration, byte/item limit, runtime limit, execution policy, and root is
validated before the owner can dispatch. Heartbeat interval remains at most
one third of lease duration; recovery attempts remain explicitly bounded.
Journal and spool identity sources remain explicit capabilities and are never
derived from delivery or attempt data. The startup cleanup counts are retained
as diagnostic evidence only and cannot alter store, admission, or session
policy.

`LocalAttemptOwner` exposes only `dispatchNext(signal?)` and returns the exact
ADR-081 immutable result. It does not expose stores, coordinators, session
factories, credentials, roots, or recovered owner capabilities. It adds no
environment loading, readiness probe, signal handler, process entry point,
sleep, timer implementation, polling, jitter, backoff, concurrency setting,
shutdown protocol, or automatic retry. `LocalRunnerNotEnabledError` remains
the production entry-point behavior. Concrete Node timing adapters, repeated
dispatch lifecycle, process configuration, and runner enablement remain later
independent decisions.

Evidence: architecture commit `0309df8` preceded production code.
Implementation commit `6046a23` added the recovery-bound owner, separated
captured configuration from graph assembly, and passed 20 focused inertness,
ordering, root-isolation, fail-stop, mutation, concurrency, fresh-publication,
and restart-recovery tests. All 844 runner-local tests and every local
repository gate passed against fresh migrated PostgreSQL database
`socrates_ci_adr082b`, including the Chromium measured-research journey and
production build. Main CI run `30722897508` passed all PostgreSQL, API, runner,
Linux native durability, Chromium product-journey, production-build, and
evidence-upload gates. This admits ADR-082 and closes Slice 2.45. Node timing
adapters, repeated dispatch lifecycle, process configuration, and runner
enablement remain separate decisions.

### ADR-083: Node attempt timing preserves exact abort authority

ADR-026 and ADR-082 still require callers to supply a
`LeaseAuthorityScheduler` and `MonotonicTimeSource`. Tests use deterministic
fakes, but there is no admitted Node implementation. A naive
`node:timers/promises.setTimeout()` adapter is not equivalent to the existing
monitor contract: aborting it rejects an `AbortError` wrapper rather than the
exact `AbortSignal.reason` sentinel used by ADR-026 to distinguish checkpoint
wake-up, clean owner release, and genuine scheduler failure. Treating that
wrapper as a scheduler failure would revoke a healthy sandbox during normal
settlement.

One effect-free `NodeLeaseAuthorityScheduler` will therefore implement only
attempt-authority waits. `wait(delayMs, signal)` accepts a positive safe
integer no greater than `2_147_483_647`, preventing Node's oversized-delay
clamping from turning a long heartbeat interval into an immediate timer. It
creates exactly one referenced Node timer and one abort listener per active
wait. Normal expiry removes the listener and resolves `undefined`. Abort
cancels the timer, removes the listener, and rejects with the exact current
`signal.reason` object, including symbol and object identity. An already-
aborted signal schedules no timer.

Timer expiry and abort are first-settlement-wins. A late callback after abort
or a late abort after expiry is inert. The production timer cancellation API
does not throw; an injected fault seam may do so for tests, but cancellation
failure cannot replace the authoritative abort reason. The callback remains
guarded and performs no later effect. Timer scheduling failure rejects one
fixed `NodeAttemptTimingError` with code `schedule_failed`; its public message
contains no callback, signal reason, path, or dependency detail while the
private cause remains available in memory. Invalid delay or signal input fails
before a timer/listener effect with code `invalid_wait`. A malformed timer
driver fails during inert construction with code `invalid_driver`.

The timer remains referenced deliberately: a process that still owns an
active lease-authority monitor must not exit merely because the next heartbeat
is waiting. This scheduler does not interpret lease timestamps, calculate
heartbeat cadence, retry a heartbeat, add jitter, poll for work, sleep after
idle admission, or schedule concurrent attempts. Those policies remain with
their explicit owners.

One frozen `nodeMonotonicTimeSource` will read `performance.now()` on demand.
It performs no read at module initialization, never uses wall-clock
`Date.now()`, does not persist a process-relative value, and does not round or
convert it. ADR-079 remains responsible for validating finite non-negative
readings and converting elapsed duration to an integer. The monotonic source
is valid only for one in-process observation; restart recovery never attempts
to resume a prior process's runtime timer.

Both adapters are exported through the existing supervision/execution module
boundaries but are not installed as hidden defaults in `LocalAttemptOwner`.
Process composition must still choose them explicitly. This slice adds no
environment loading, process entry point, OS signal handler, repeated dispatch
lifecycle, idle timer, polling, backoff, shutdown owner, or `LocalRunner`
enablement.

Evidence: architecture commit `3380609` preceded production code.
Implementation commit `1d96858` added the bounded referenced scheduler, frozen
monotonic source, and 35 focused fault, race, identity, cleanup, mutation,
monitor, and timing-barrier tests. All 879 runner-local tests and every local
repository gate passed against fresh migrated PostgreSQL database
`socrates_ci_adr083`, including the Chromium measured-research journey and
production build. Main CI run `30723737177` passed all PostgreSQL, API, runner,
Linux native durability, Chromium product-journey, production-build, and
evidence-upload gates. This admits ADR-083 and closes Slice 2.46. Repeated
dispatch lifecycle, process configuration, shutdown ownership, and runner
enablement remain separate decisions.

### ADR-084: Repeated local dispatch is one observed fail-stop lifecycle

ADR-082 exposes one safe `dispatchNext()` boundary and ADR-083 supplies the
required Node timing primitives, but a future process root could still invent
unsafe repetition. A naive loop could overlap attempts, busy-spin on idle,
use local wall time to reinterpret an indeterminate lease, discard dispatch
outcomes, retry an uncertain owner failure, or let shutdown detach an active
session. Repetition is therefore admitted as its own lifecycle before process
configuration or runner enablement.

One effect-free `LocalAttemptDispatchLoop` will accept only a narrow
`dispatchNext(signal?)` owner, a narrow delay capability, one observer, and one
fixed `pollIntervalMs`. The interval is snapshotted as an integer in
`[1, 2_147_483_647]`, matching the admitted Node timer bound. Dependency
methods are captured during construction so later mutation cannot redirect
dispatch, delay, or observation. Construction performs no recovery, store,
network, timer, clock, callback, or process effect.

The first explicit `run(signal)` creates one retained operation; every later
call returns that exact promise and cannot replace its shutdown signal. The
loop performs exactly one awaited `dispatchNext(signal)` at a time. It awaits
the deeply immutable result, validates the closed ADR-081 state union, and
then awaits `observe(result)` before selecting another transition. No next
dispatch or delay can begin until observation succeeds. The observer is a
process-local operational boundary only: it cannot mutate durable attempt
truth or authorize the next transition.

`idle` and `indeterminate` are the only delayed outcomes. Idle delay prevents
empty acquisition from becoming a busy loop. Indeterminate delay permits a
later exact control-plane reconciliation without reading or calculating from
`leaseExpiresAt`; the server/database clock remains the only retirement
authority. `settled`, `completed`, `retired`, and `rejected` advance directly
to the next explicit durable transition because the preceding call has
already fully settled or recorded its closed local truth. There is no delay
after those results and no attempt concurrency.

Shutdown remains cooperative and non-authoritative. An already-aborted signal
returns one frozen `stopped` result without dispatch, delay, or observation.
Abort during admission may stop the loop only when the rejection is the exact
current `signal.reason`. Abort during an owned session cannot replace ADR-072
cancellation authority: ADR-081 waits for the session to settle, the loop
observes that result, and only then stops before another transition. Abort
during a poll delay must likewise reject with exact reason identity; the loop
then returns `stopped`. The stopped result never exposes the possibly private
abort reason.

Every other dispatch, observation, or delay rejection is terminal and becomes
one fixed `LocalAttemptDispatchLoopError` with a redacted message and retained
cause. Invalid result shape is a separate fixed failure. No uncertain failure
is retried in-process, no later observer runs, and no later timer or dispatch
is created. A fresh process with new owners remains the only recovery path.

This lifecycle adds no exponential backoff, jitter, adaptive cadence,
concurrency setting, retry budget, wall-clock lease calculation, environment
loading, credentials, logging implementation, process entry point, OS signal
handler, shutdown timeout, resource construction, or `LocalRunner` enablement.
The concrete process root must later choose the owner, delay adapter, observer,
configuration source, and shutdown authority explicitly. Until that separate
decision is admitted, `LocalRunnerNotEnabledError` remains the production
entry-point behavior.

Evidence: architecture commit `b85d656` preceded production code.
Implementation commit `c7b1ec6` added the retained observed lifecycle, strict
closed-result snapshot boundary, and 43 focused ordering, identity, shutdown,
delay, mutation, fault, real-owner, and real-scheduler tests. All 922
runner-local tests and every local repository gate passed against fresh
migrated PostgreSQL database `socrates_ci_adr084`, including the Chromium
measured-research journey and production build. Main CI run `30724666887`
passed all PostgreSQL, API, runner, Linux native durability, Chromium
product-journey, production-build, and evidence-upload gates. This admits
ADR-084 and closes Slice 2.47. Process configuration, concrete observation,
shutdown ownership, resource composition, and runner enablement remain
separate decisions.

### ADR-085: Source resolution authority is created per exact attempt

ADR-058 deliberately makes `BoundedSourceArtifactResolver` one-shot and bound
to one exact lease identity. ADR-082 currently accepts one
`ExecutionSourceArtifactResolver` in `LocalAttemptOwnerOptions` and shares that
instance across every future fresh session. Deterministic tests use a stateless
resolver fake, so they do not expose the mismatch. A concrete ADR-058 resolver
would retain the first attempt's snapshot, digest, and signal authority;
reusing it for a second attempt would either reject with an authority conflict
or retain the wrong lease identity. Production composition cannot proceed
through that boundary.

`ExecutionSourceArtifactResolver` will therefore become an explicit
attempt-scoped capability carrying its deeply frozen
`SandboxAttemptIdentity` alongside `resolve()`. A new
`ExecutionSourceArtifactResolverFactory` exposes only
`create(identity)`. `AttemptPreparationCoordinator` derives the identity from
its strictly parsed `RunnerExecutionV1`; callers cannot supply a separate
identity. Construction captures the factory method but invokes no factory,
transport, store, filesystem, image, or sandbox effect.

On the first explicit `prepare(signal?)`, after projection and the existing
pre-cancellation check, the coordinator calls `create()` exactly once with its
derived identity. It validates that the returned resolver is an object, owns
the byte-exact runner/task/attempt/fence identity, and exposes a callable
`resolve`. It snapshots the identity and captures the method before source
transport can begin. Missing, malformed, identity-drifted, or throwing factory
output becomes one fixed `AttemptPreparationError` with code
`invalid_artifact_resolver`; no source, image, materialization, or sandbox
effect follows. The created resolver and its failure remain owned by that one
preparation operation.

`LocalAttemptOwner` will accept and capture the factory rather than a resolver
instance. Its captured facade validates every produced resolver again and
tracks object identity for the owner lifetime. Returning the same resolver
object from two factory calls fails closed before its second `resolve`, even
when both calls concern the same attempt identity. This prevents a custom
factory from smuggling one-shot authority across sessions. Dependency method
mutation after owner construction cannot redirect creation or resolution.

One concrete `BoundedSourceArtifactResolverFactory` will bind the positive
archive-byte maximum, source transport, and artifact-store write capability.
Construction validates and captures only the narrow `open` and `put` methods
without I/O. Each `create(identity)` validates and snapshots the identity and
returns a distinct ADR-058 resolver. `BoundedSourceArtifactResolver` itself
exposes that frozen identity and uses the captured transport/store facades, so
later dependency mutation cannot redirect an already-created authority.
Resolvers created for different attempts retain fully independent one-shot
operations, signals, results, and failures.

This correction does not change task or HTTP contracts, source byte policy,
artifact storage, extraction, image admission, runtime execution, dispatch
cadence, environment loading, process startup, shutdown ownership, or runner
enablement. `LocalRunnerNotEnabledError` remains the production entry-point
behavior. Concrete resource composition and configuration remain later
decisions after the per-attempt authority graph is sound.

Evidence: architecture commit `08660c6` preceded production code.
Implementation commit `91629b4` added exact immutable identity snapshots,
attempt-scoped resolver creation, owner-lifetime reuse rejection, the concrete
bounded resolver factory, and 22 new adversarial tests. All 944 runner-local
tests and every platform-independent local repository gate passed against
fresh migrated PostgreSQL database `socrates_ci_adr085`, including the
Chromium measured-research journey and production build. Main CI run
`30725526404` passed all PostgreSQL, API, runner, Linux native durability,
Chromium product-journey, production-build, and evidence-upload gates. This
admits ADR-085 and closes Slice 2.48. Environment loading, process resource
composition, shutdown ownership, and runner enablement remain separate
decisions.

### ADR-086: Local runner configuration is one strict non-secret snapshot

The admitted local-runner components now expose enough independent constructor
options to build a real resource graph, but those options duplicate authority
across transport, source, runtime, durability, sandbox, and lifecycle
boundaries. Wiring them directly from environment variables would permit one
archive limit, runner identity, root path, or cadence to drift between
components. It would also mix untrusted textual input, secret acquisition, and
resource construction in one irreversible process boundary.

Before any resource composition or entry-point enablement, the runner will
therefore own one versioned `LocalRunnerConfigurationV1` data contract and one
`parseLocalRunnerConfiguration(candidate)` boundary. The contract is a strict
closed object containing only non-secret values: deployment and runner
identity; control-plane origin and bounded transport sizes/timing; private
artifact, source, journal, and spool roots; engine executable and bounded
control/execution settings; source extraction, runtime request, runtime
protocol, execution policy, durability, lease, recovery, and poll limits.
Credentials, bearer tokens, environment maps, image catalog contents,
functions, clocks, schedulers, observers, signals, and constructed resources
are not configuration fields.

The parser accepts an unknown candidate, rejects unknown keys at every level,
validates all integers as positive or explicitly bounded non-negative safe
integers, validates the runner UUID and a constrained deployment identifier,
and admits only an HTTPS origin with no user info, path, query, or fragment.
Private roots are absolute canonical POSIX paths and must be pairwise distinct
and non-nested. The engine executable is non-empty and NUL-free. One field is
the sole authority for each value consumed by multiple future resources: in
particular source archive bytes, runtime output bytes, runner identity, engine
executable, and lifecycle timing are not repeated in separate subtrees.

Relational invariants are validated at the outer boundary. Heartbeat cadence
must not exceed one third of lease duration, matching the admitted authority
monitor; revocation grace cannot exceed either the lease or 60 seconds;
per-file source bytes cannot exceed expanded source bytes; archive bytes
cannot exceed both transport and artifact admission because the shared field
configures all three; the protocol budget must hold one complete admitted
runtime frame including its four-byte prefix, while protocol and child-output
bounds cannot exceed the projected runtime-output policy; and spool/journal
item limits must fit inside their total byte budgets. The exact accepted value
is rebuilt into plain data
and deeply frozen, including every nested object. Caller mutation cannot alter
future resource authority.

Parsing is deterministic and effect-free. It does not read `process.env`, a
file, stdin, a secret store, the network, the clock, or host readiness. It does
not normalize a credential, create a directory, instantiate a transport or
sandbox, start recovery, install a signal handler, or expose a process entry
point. A later environment adapter may translate explicitly named variables
into this candidate; a later credential capability may supply secret material;
and a later resource-composition ADR may consume the admitted snapshot. Those
boundaries remain separate so configuration errors precede every external
effect and never echo secret input.

`LocalRunnerNotEnabledError` remains the production entry-point behavior. This
decision adds no local runner activation, environment loader, credential
loader, resource graph, logging implementation, shutdown owner, retry policy,
adaptive cadence, concurrency, or daemon process.

Evidence: architecture commit `a8900ba` preceded production code.
Implementation commit `0f3270e` added the strict V1 non-secret contract,
plain-data admission boundary, detached deep-freeze result, fixed redacted
errors, and 75 focused adversarial and property-based tests. All 1019
runner-local tests and every platform-independent local repository gate passed
against fresh migrated PostgreSQL database `socrates_ci_adr086`, including the
Chromium measured-research journey and production build. Main CI run
`30726331992` passed all PostgreSQL, API, runner, Linux native durability,
Chromium product-journey, production-build, and evidence-upload gates. This
admits ADR-086 and closes Slice 2.49. Environment and credential loading,
resource composition, shutdown ownership, and runner enablement remain
separate decisions.

### ADR-087: Attempt lifecycle composition is inert and capability-injected

ADR-086 supplies one authoritative non-secret snapshot, but constructing a
complete process graph would still require unresolved secret acquisition,
authenticated transport creation, trusted image declarations, host process
environment, and OCI readiness authority. Combining those concerns now would
either smuggle environment/credential policy into composition or pretend that
an unverified resource graph is production-ready. The next boundary will
therefore compose only the admitted attempt lifecycle from capabilities whose
platform authority has already been established elsewhere.

`LocalRunnerAttemptLifecycle` will accept an unknown configuration candidate
plus narrow external capabilities: one control-plane client that also opens
source snapshots, one owned sandbox backend, one image-admission port, one
lease scheduler, one monotonic time source, one dispatch observer, exact work
journal and spool identity sources, and one directory-sync capability. It
parses ADR-086 configuration before reading any capability method. Invalid
configuration therefore fails before dependency getters, filesystem, network,
process, clock, UUID, timer, recovery, image, or sandbox effects.

After configuration admission, construction captures or delegates only narrow
methods and creates the inert local objects already admitted by earlier ADRs:
one local content-addressed artifact store, one source materializer, one
attempt-scoped bounded resolver factory, one runtime request materializer, one
`LocalAttemptOwner`, and one retained `LocalAttemptDispatchLoop`. The shared
ADR-086 source archive field configures artifact download and extraction; its
runner/deployment identity configures source and request materialization; its
roots configure artifact, source, journal, and spool ownership; and its
execution, runtime, durability, lifecycle, and poll fields map once into the
corresponding admitted owners. No duplicate fallback or default authority is
introduced.

Composition is allowed to consume only configurations that every downstream
constructor can accept. Before the lifecycle implementation lands, ADR-086's
outer schema must enforce the already-admitted one-third heartbeat ceiling,
60-second revocation ceiling, and minimum complete-frame protocol budget.
Those are compatibility constraints, not new lifecycle defaults: invalid data
must remain `invalid_configuration` at the outer boundary and may not leak as
a later `composition_failed` constructor error.

The lifecycle exposes only `run(signal)` and the fixed stopped result. It does
not expose constructed stores, roots, configuration, control-plane transport,
sandbox, image port, identity sources, or observer. Construction is entirely
inert: local store and materializer constructors do not touch disk, owner and
dispatch constructors do not recover or poll, and no external capability is
invoked. The first explicit `run` retains the existing startup-first recovery,
serial dispatch, authenticated attempt ownership, observation, delay, and
fail-stop semantics. Concurrent or repeated calls share the dispatch loop's
one operation.

Configuration errors and composition/dependency errors receive separate fixed
`LocalRunnerAttemptLifecycleError` codes and public messages with retained
causes. Later mutation of supplied objects cannot redirect captured methods.
No composition failure retries or leaves a runnable partial graph. A valid
graph owns its internal resources for its lifetime and cannot be reconfigured.

This layer deliberately does not construct `RunnerHttpClient`, credentials,
`NodeProcessExecutor`, host readiness, `NerdctlSandboxBackend`, image inspector,
handshake verifier, or trusted image catalog. It does not compare a supplied
capability with the still-unconsumed ADR-086 control-plane and engine fields;
the later platform-resource ADR must construct those capabilities from the
same snapshot and prove that mapping. It also adds no environment/file loader,
secret loader, process entry point, logging implementation, OS signal handler,
shutdown timeout, runner feature flag, or activation. `LocalRunnerNotEnabledError`
remains the production entry-point behavior.

Implementation commit `898e67f` adds the opaque frozen lifecycle, captures
every injected method after configuration admission, aligns ADR-086 with all
downstream constructor bounds, and retains one serial dispatch operation.
Thirty-six focused lifecycle tests cover inert construction, every capability
getter, missing/non-callable/proxy dependencies, post-construction mutation,
exact boundary composition, invalid and pre-aborted signals, real idle startup,
startup/dispatch/observation/delay fail-stop behavior, and one measured tar
snapshot through artifact, source, request, runtime, journal, spool,
publication, and cleanup boundaries. Seventy-seven parser tests preserve the
strict configuration boundary.

All 1,057 runner-local tests and every locally applicable repository gate
passed against fresh migrated PostgreSQL database
`socrates_ci_adr087_retry`, including the Chromium measured-research journey
and production build. Main CI run `30727600459` passed every PostgreSQL, API,
runner, Linux native durability, Chromium product-journey, production-build,
and evidence-upload gate. This admits ADR-087 and closes Slice 2.50. Platform
resource construction, credentials, environment loading, process startup,
shutdown ownership, and runner enablement remain separate decisions.

### ADR-088: Authenticated control-plane composition owns one secret snapshot

ADR-087 deliberately injects a broad already-authorized control-plane
capability because ADR-086 contains no secret. Leaving that capability as the
root boundary forever would fail to prove that the configured origin,
transport timeout, response ceiling, source archive ceiling, runner
credential, and actual HTTP client belong to one resource graph. Constructing
the OCI backend and image catalog at the same time is not justified: trusted
image declarations and their deployment-loading policy remain unresolved.

The next boundary will therefore compose only authenticated control-plane
transport. One `LocalRunnerAuthenticatedAttemptLifecycle` will accept an
unknown ADR-086 configuration candidate, one separately supplied unknown
bearer-credential candidate, one required `fetch` capability, and every
non-transport capability already accepted by ADR-087. It parses and detaches
the non-secret configuration before reading the credential, fetch, sandbox,
image, scheduler, time, observer, identity, or directory-sync property.
Malformed configuration therefore wins before any secret or capability getter
and before every filesystem, network, process, clock, timer, recovery, image,
or sandbox effect.

After configuration admission, the wrapper reads the credential exactly once
and requires the existing strict runner bearer-token contract. It retains no
secret in a public field, error message, serialized diagnostic, configuration
snapshot, log, or returned result. A malformed or throwing credential boundary
becomes one fixed `invalid_credential` error; the original cause may remain
only in memory. Credential rotation requires a fresh graph rather than
silently replacing authority beneath an in-flight attempt.

The wrapper requires an injected callable `fetch` instead of falling back to
ambient `globalThis.fetch`. It constructs exactly one `RunnerHttpClient` with
`controlPlane.origin`, `controlPlane.timeoutMs`,
`controlPlane.maximumResponseBytes`, and `source.maximumArchiveBytes`; HTTPS
remains mandatory and `allowInsecureHttp` is never enabled. The same client
owns task acquisition, claim/reconciliation, heartbeat, event submission, and
source-snapshot transport. No alternate URL, timeout, byte ceiling, credential,
or retry default is introduced.

The admitted detached configuration is passed into ADR-087 and re-admitted at
that public boundary, producing an equivalent private snapshot without reading
the original candidate again. The existing injected sandbox, image, scheduler,
time, observer, journal/spool identity, and directory-sync capabilities remain
unchanged. The wrapper retains only ADR-087's `run(signal)` operation, is frozen
and opaque, and construction performs no fetch or other external effect.
Concurrent or repeated calls share the same underlying lifecycle operation.

Errors are fixed and redacted: non-secret configuration, credential,
dependency, and unexpected composition failures remain distinguishable.
Later mutation of the original options, fetch property, or other dependency
methods cannot redirect the retained graph. A first transport, startup,
dispatch, observation, or delay failure remains fail-stop through ADR-087 and
is never used to construct a second client or lifecycle.

This slice adds no credential source, environment/file/stdin/secret-store
loader, refresh protocol, logging implementation, trusted image catalog,
`NodeProcessExecutor`, host readiness, `NerdctlSandboxBackend`, image inspector,
handshake verifier, process entry point, OS signal handling, shutdown timeout,
feature flag, or runner activation. ADR-086 engine fields remain unconsumed and
`LocalRunnerNotEnabledError` remains the production entry-point behavior.

Architecture commit `e1150cf` preceded production code. Implementation commit
`01c49fd` adds the frozen opaque authenticated lifecycle, constructs one exact
`RunnerHttpClient`, fixes strict heartbeat route-parameter projection, and
isolates the fake-runner integration from shared demo data. Nineteen focused
composition tests prove configuration-before-secret ordering, inert and
redacted construction, dependency capture, retained failure, exact timeout and
response/source bounds, authenticated idle operation, and one measured source
flow through the same client. The transport suite separately locks the valid
heartbeat request and route projection.

All 1,077 runner-local tests and every locally applicable repository gate
passed with fresh migrated PostgreSQL, including a parallel full-workspace run
against `socrates_ci_adr088_full_retry`, the Chromium measured-research journey
against `socrates_ci_adr088_e2e`, and the production build. Main CI run
`30728698907` passed every PostgreSQL, API, runner, Linux native durability,
Chromium product-journey, production-build, and evidence-upload gate. This
admits ADR-088 and closes Slice 2.51. Credential loading and refresh, trusted
image declarations, OCI/platform bootstrap, process entry, shutdown ownership,
feature flags, and runner enablement remain separate decisions.

### ADR-089: Trusted image declarations have one digest authority

ADR-088 leaves the image-admission capability injected because the existing
`TrustedSandboxImage` is only a TypeScript structural type. Passing environment
or file contents directly into that constructor would allow accessors, sparse
arrays, unbounded strings, duplicate authority, or mutable nested data to reach
the platform graph. Composing OCI resources before this boundary exists would
therefore make an unverified deployment document authoritative.

Slice 2.52 introduces one strict V1 trusted-image catalog configuration parser.
Its unknown candidate is a closed object containing `version: "1"` and between
one and 32 image declarations. Each declaration contains exactly one bare
platform-manifest `digest`, one admitted OCI manifest media type, the rootfs
configuration digest, Linux architecture, runtime build and bundle digests,
fixed runtime and profile-probe commands, and exact non-secret environment
defaults. The V1 catalog version implies the current fixed `runtimeAbi`; an
input ABI alias cannot override code and protocol authority.

The admitted declaration has one digest field. The existing duplicate
`reference` and `manifestDigest` fields are removed from
`TrustedSandboxImage`; catalog inspection derives both engine reference and
expected manifest identity from the same digest at the call boundary. A digest
may occur only once in a catalog. Tags, registry references, platform aliases,
fallback images, and caller-selected local names remain unrepresentable.

Candidate admission accepts only plain objects and dense plain arrays. It
rejects custom prototypes, accessors, functions, symbols, cycles, array holes,
array extension keys, excessive nesting, and excessive node counts without
invoking a candidate getter. The structural validator is shared with ADR-086
while preserving ADR-086's array-rejecting behavior. Successful parsing
rebuilds and deeply freezes a detached graph; later mutation of the original
candidate cannot change catalog authority.

Every digest is lowercase `sha256`, commands use one bounded absolute
executable and at most 128 bounded no-NUL arguments, and environment entries
have bounded UTF-8 size and aggregate size. Environment names are unique,
portable uppercase identifiers and credential-like names remain forbidden.
The structural ceiling is 32 nested containers and 10,000 visited nodes. An
executable or argument is at most 4,096 UTF-8 bytes and one command is at most
65,536 aggregate UTF-8 bytes. One image has at most 128 environment entries;
each is at most 8,192 UTF-8 bytes and their aggregate is at most 262,144 bytes.
The catalog count, environment count, string-byte, aggregate-byte, depth, and
node ceilings are explicit exported contract constants and are tested at both
edges. Invalid candidates receive fixed `invalid_candidate` or
`invalid_configuration` errors that never echo input values.

Parsing is deterministic and inert. It performs no environment, file, stdin,
secret-store, network, process, clock, UUID, image inspection, handshake,
readiness, or sandbox operation. It does not construct a
`SandboxImageCatalog`, `NodeProcessExecutor`, `NerdctlReadinessVerifier`, or
`NerdctlSandboxBackend`. A later platform-composition ADR must consume this
admitted snapshot together with ADR-086 and prove exact process, readiness,
backend, inspector, handshake, and catalog mapping.

This slice adds no catalog loader, signature or registry policy, image pull or
build, credential loading, process entry point, signal handling, shutdown
owner, feature flag, or runner activation. `LocalRunnerNotEnabledError` remains
the production entry-point behavior until those independent authorities are
admitted and composed.

## 19. Explicit non-goals for the first commit

- autonomous agents or provider integrations
- shell or code execution
- authentication
- billing
- production database provisioning
- functional run controls
- distributed scheduling
- chat UI

The first commit proves product structure, visual hierarchy, navigation, and
architectural boundaries. It does not pretend the research engine exists.
