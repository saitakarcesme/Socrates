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
