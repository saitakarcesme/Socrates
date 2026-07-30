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

- PostgreSQL and migrations
- project/run creation
- versioned metrics and baselines
- manually recorded experiments and decisions
- durable event timeline

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
