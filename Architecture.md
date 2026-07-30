# Socrates Architecture

Status: Accepted for the product skeleton  
Last updated: 2026-07-30  
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

Every runner task receives an immutable `ExperimentTask`:

```ts
type ExperimentTaskV1 = {
  version: "1";
  runId: string;
  experimentId: string;
  source: SourceSnapshot;
  hypothesis: string;
  actionPlan: ActionPlan;
  metric: MetricProtocol;
  constraints: ConstraintProtocol[];
  budget: ExperimentBudget;
  environment: RunnerRequirements;
};
```

The runner emits ordered, idempotent events:

```ts
type RunnerEventV1 =
  | TaskAccepted
  | WorkspacePrepared
  | ActionStarted
  | LogAppended
  | ArtifactProduced
  | MeasurementRecorded
  | TaskSucceeded
  | TaskFailed
  | TaskCancelled;
```

Each event carries `eventId`, `taskId`, monotonically increasing `sequence`,
timestamp, schema version, and payload. The API rejects duplicate event IDs and
buffers or rejects invalid sequence gaps.

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

### Phase 0 — product skeleton (current)

- monorepo and shared tooling
- design tokens and UI primitives
- dashboard, project, run, experiment, learnings, and settings screens
- typed domain and contract placeholders
- Hono health/readiness surface and module boundaries
- realistic read-only fixture data
- no autonomous execution

### Phase 1 — measured manual experiments

- implementation plan:
  [`docs/plans/phase-1-measured-experiments.md`](docs/plans/phase-1-measured-experiments.md)
- PostgreSQL and migrations
- project/run creation
- versioned metrics and baselines
- manually recorded experiments and decisions
- durable event timeline

Phase 1 remains manual by design. Its acceptance gate explicitly forbids runner,
shell executor, and model-provider dependencies.

### Phase 2 — local runner

- task protocol and runner registration
- sandboxed local execution
- logs, artifacts, cancellation, and budgets
- deterministic decision policy

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
cannot silently remove the pagination contract.

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
