# Phase 1 Plan: Measured Manual Experiments

Status: In progress
Owner: Socrates core
Prerequisite: Phase 0 product skeleton
Architecture baseline: [Architecture.md](../../Architecture.md)

## 1. Outcome

Phase 1 replaces read-only fixtures with durable, manually operated research
records. A user can define a measurable project, record a baseline, create a
bounded run, enter experiments and observations, apply the deterministic
decision policy, and preserve evidence-backed learnings.

The phase proves the measurement and knowledge ledger before any autonomous
agent or runner is allowed to act.

## 2. Scope

### Included

- one seeded workspace boundary
- project creation and listing
- versioned primary metric definitions
- run budgets and lifecycle commands
- baseline observations
- manually entered experiments and actions
- before/after observations
- deterministic keep, discard, or inconclusive decisions
- manually authored learnings with experiment evidence
- append-only run events
- resumable SSE timeline updates
- fixture-to-API migration for all current product screens
- database, API, domain, and route integration tests

### Explicitly excluded

- autonomous hypothesis generation
- LLM provider integration
- arbitrary command or code execution
- local, cloud, or distributed runner implementation
- artifact binary storage
- authentication and workspace membership
- billing and payment collection
- branching experiment search
- automatic knowledge extraction

Phase 1 must not introduce a hidden shell executor, mock agent, or background
loop that resembles a runner.

## 3. User journeys

### Create a measured project

1. User supplies name, objective, source reference, primary metric, unit,
   direction, minimum improvement, and optional guardrails.
2. API creates the project and metric definition in one transaction.
3. Dashboard and project list reflect the new project.

### Establish a baseline

1. User creates a draft run with experiment, time, and cost limits.
2. User records a baseline value and measurement notes.
3. Run becomes startable only after its baseline validates against the current
   metric definition.

### Record an experiment

1. User enters hypothesis and planned action.
2. User marks the experiment executing, then records the result observation.
3. Socrates applies the versioned decision policy.
4. The timeline shows before, after, delta, decision reason, duration, and
   learned knowledge.

### Preserve knowledge

1. User writes a learning against one or more completed experiments.
2. Evidence links are immutable.
3. Confidence and lifecycle status may change without deleting prior evidence.

## 4. Domain additions

All rules live in `packages/domain`; API handlers only translate commands and
responses.

### Value objects

- `MetricValue`: decimal string plus unit
- `MetricProtocolVersion`: immutable identifier
- `BudgetLimit`: experiment count, wall-clock milliseconds, and integer cost
  minor units
- `BudgetUsage`: derived from recorded facts
- `ExpectedVersion`: optimistic concurrency token
- `EventCursor`: run-local monotonically increasing integer

JavaScript floating-point values are not used as the persistence or API format
for measured decimals. API contracts carry canonical decimal strings and domain
comparison converts through an explicit decimal implementation.

### Policies

- `canStartRun`: baseline and budget are valid
- `canProposeExperiment`: run is active and remaining budget permits it
- `recordObservation`: protocol version and unit match
- `decideExperiment`: direction, threshold, noise tolerance, and guardrails
- `completeRun`: no executing experiment remains
- `deriveBudgetUsage`: immutable facts to current usage
- `attachLearningEvidence`: evidence belongs to the same workspace

### Optimistic concurrency

Mutable aggregates carry an integer `version`. Commands include
`expectedVersion`; an update succeeds only when the stored version matches.
Conflicts return `409 version_conflict` with the current version. This prevents
two tabs from silently applying incompatible lifecycle commands.

## 5. Persistence design

PostgreSQL is authoritative. Drizzle schema files and generated SQL migrations
are committed together.

### Migration policy

- `drizzle-kit generate` creates reviewed SQL and schema snapshots.
- `drizzle-kit check` runs in CI.
- `drizzle-kit migrate` applies committed migrations.
- `drizzle-kit push` is prohibited outside disposable local experiments.
- migrations are forward-only; recovery uses a reviewed corrective migration
  or database restore
- production seed data is never embedded in schema migrations

This follows the documented Drizzle code-first migration flow:
[generate](https://orm.drizzle.team/docs/drizzle-kit-generate) and
[kit overview](https://orm.drizzle.team/docs/kit-overview).

### Tables

#### `workspaces`

- `id`
- `name`
- `created_at`, `updated_at`
- seeded development workspace only; membership remains out of scope

#### `projects`

- `id`, `workspace_id`
- `name`, `slug`, `objective`
- `source_type`, `source_reference`
- `status`
- `version`
- timestamps
- unique `(workspace_id, slug)`

#### `metric_definitions`

- `id`, `project_id`
- `version`
- `name`, `unit`, `direction`
- `minimum_improvement`
- `noise_tolerance`
- evaluator configuration JSON restricted to display/manual-entry metadata
- `created_at`
- unique `(project_id, version)`

Metric definitions are immutable. Editing creates a new version.

#### `constraint_definitions`

- `id`, `metric_definition_id`
- `name`, `unit`, `operator`, `threshold`
- `hard`

#### `runs`

- `id`, `project_id`, `metric_definition_id`
- project-local sequence
- title, objective snapshot
- lifecycle status
- `version`
- started/completed timestamps
- unique `(project_id, sequence)`

#### `run_budgets`

- `run_id`
- maximum experiment count
- maximum duration milliseconds
- maximum cost minor units

Usage is derived from experiments and observations; duplicated usage counters
are not persisted in Phase 1.

#### `experiments`

- `id`, `run_id`
- run-local sequence
- nullable parent experiment ID for future search
- hypothesis, action summary
- lifecycle status
- `version`
- started/completed timestamps
- unique `(run_id, sequence)`

#### `observations`

- `id`, `run_id`, nullable `experiment_id`
- kind: baseline, before, after, or guardrail
- metric definition ID
- canonical decimal value and unit
- sample count, notes, environment metadata
- recorded timestamp

Observations are immutable.

#### `decisions`

- `id`, `experiment_id`
- policy version
- automated decision and machine-readable reason
- final decision and optional override reason
- calculated improvement
- created timestamp

At most one active decision exists per experiment. Corrections append a
superseding decision rather than modifying evidence.

#### `learnings`

- `id`, `project_id`
- statement, confidence, lifecycle status
- superseded learning ID
- timestamps

#### `learning_evidence`

- `learning_id`, `experiment_id`
- evidence role
- composite primary key

#### `run_events`

- `id`, `run_id`
- run-local `sequence`
- type, schema version, JSON payload
- occurred timestamp
- unique `(run_id, sequence)`

#### `idempotency_keys`

- workspace ID, key, command name
- request fingerprint
- response status and JSON body
- created and expiry timestamps
- composite uniqueness across workspace, key, and command

### Transaction rules

Every state-changing command:

1. validates idempotency
2. loads and locks the target aggregate
3. verifies `expectedVersion`
4. applies domain policy
5. writes domain rows
6. appends exactly one or more `run_events`
7. stores the idempotent response
8. commits atomically

Read Committed is sufficient when aggregate rows are explicitly locked and
version-checked. Cross-aggregate commands must lock records in documented,
stable order to avoid deadlocks.

## 6. Package boundaries

```text
packages/contracts
  project, metric, run, experiment, observation, learning, event schemas

packages/domain
  entities, value objects, lifecycle transitions, decision and budget policies

packages/database
  Drizzle schema, migrations, transaction boundary, repository implementations

apps/api/src/modules
  projects/
  runs/
  experiments/
  learnings/
  events/
```

Repository ports are declared beside application use cases in the domain or
application boundary. Drizzle types do not escape `packages/database`.

The web application imports response contract types, never database schema
types.

## 7. API contract

Prefix: `/v1`.

### Reads

- `GET /projects`
- `GET /projects/:projectId`
- `GET /projects/:projectId/runs`
- `GET /runs/:runId`
- `GET /runs/:runId/experiments`
- `GET /experiments/:experimentId`
- `GET /projects/:projectId/learnings`
- `GET /learnings`
- `GET /runs/:runId/events?after=<cursor>`

List endpoints use cursor pagination with stable `(created_at, id)` ordering.

### Commands

- `POST /projects`
- `POST /projects/:projectId/metric-definitions`
- `POST /projects/:projectId/runs`
- `POST /runs/:runId/baseline`
- `POST /runs/:runId/start`
- `POST /runs/:runId/experiments`
- `POST /experiments/:experimentId/start`
- `POST /experiments/:experimentId/observations`
- `POST /experiments/:experimentId/decide`
- `POST /experiments/:experimentId/learning`
- `POST /runs/:runId/complete`
- `POST /runs/:runId/cancel`

Commands use explicit lifecycle routes; generic status patches are prohibited.

### Request requirements

- `Idempotency-Key` on every command
- `expectedVersion` for aggregate mutations after creation
- Zod schemas exported by `packages/contracts`
- Hono Standard Schema validation middleware
- unknown request fields rejected
- decimal measurements transmitted as strings

Hono documents Standard Schema/Zod validation as a type-safe middleware pattern:
[Hono validation](https://hono.dev/docs/guides/validation).

### Error envelope

```ts
type ApiError = {
  error: {
    code:
      | "validation_failed"
      | "not_found"
      | "invalid_transition"
      | "version_conflict"
      | "idempotency_conflict"
      | "budget_exhausted"
      | "protocol_mismatch"
      | "internal_error";
    message: string;
    requestId: string;
    details?: Record<string, unknown>;
  };
};
```

Domain errors map centrally to HTTP status codes. Handlers do not invent
route-specific error shapes.

## 8. Realtime design

Endpoint: `GET /v1/runs/:runId/events`.

- response uses Hono `streamSSE`
- event ID is the durable run-local sequence
- reconnect accepts standard `Last-Event-ID`
- the initial connection replays committed events after the cursor
- a process-local notifier reduces latency
- periodic database reconciliation closes notifier race windows
- authorization is evaluated before streaming and on reconnect
- heartbeat comments keep infrastructure connections alive
- slow consumers are disconnected and resume from their last durable cursor

The process-local notifier is an optimization, never the source of truth.
Hono's supported SSE helper is documented at
[Streaming Helper](https://hono.dev/docs/helpers/streaming).

## 9. Web implementation

### Data access

- one typed Hono API client in `apps/web/src/lib/api`
- Server Components fetch initial route snapshots from Hono
- a small client timeline reconciler subscribes to SSE
- Zustand stores only timeline selection, filters, and transient event cursors
- no database imports in `apps/web`
- no duplicate Next.js business endpoints

### UI enablement sequence

1. Project creation form enables `New project`.
2. Project screen enables metric revision and `New run`.
3. Run screen enables baseline entry and lifecycle commands.
4. Experiment form enables hypothesis, action, and observations.
5. Decision panel displays policy reason before learning entry.
6. Settings remain read-only until persistence is explicitly in scope.

Forms use inline validation, preserve user input on API errors, focus the first
invalid field, and expose pending state without decorative animation.

### Fixture removal

Completed. All product routes use validated control-plane projections. The
global learning surface uses a workspace projection rather than a
project-by-project request fan-out.

## 10. Delivery sequence

### Commit 1 — contracts and domain

- decimal metric value object
- complete run and experiment state machines
- budget and decision policies
- request/response schemas
- property and unit tests

Exit gate: domain and contract packages have no framework or database imports.

### Commit 2 — schema and migrations

- normalized Drizzle schema
- migration configuration
- initial generated SQL migration
- repository ports and implementations
- transaction and idempotency primitives

Exit gate: clean PostgreSQL can migrate from zero; migration check passes.

### Commit 3 — read API

- project, run, experiment, and learning modules
- typed read endpoints
- cursor pagination
- centralized error mapping

Exit gate: API integration tests read deterministic seed data.

### Commit 4 — command API

- create and lifecycle use cases
- optimistic concurrency
- idempotency
- atomic event append

Exit gate: duplicate commands return the original response and conflicting
payloads fail.

### Commit 5 — durable SSE

- event replay
- reconnect cursor
- notifier plus reconciliation
- heartbeat and abort cleanup

Exit gate: disconnect/reconnect test receives every event exactly once at the
client projection.

### Commit 6 — web read migration

- typed API client and runtime validation
- Server Component snapshots
- evidence-enriched timeline projection
- workspace learning projection
- fixture removal

Exit gate: all product screens render committed control-plane facts and a
production build does not require a live API.

### Commit 7 — manual workflow

- creation and manual experiment forms
- SSE timeline reconciliation

Exit gate: all product screens operate against PostgreSQL with no fake enabled
controls.

### Commit 8 — hardening

- end-to-end journey tests
- accessibility and responsive browser verification
- query/index inspection
- operator documentation

Exit gate: full CI and Phase 1 acceptance matrix pass.

## 11. Test matrix

### Domain

- every allowed and forbidden lifecycle transition
- maximize and minimize decisions
- exact threshold boundary
- noise tolerance and invalid measurements
- guardrail failure
- experiment, time, and cost budget exhaustion
- decimal precision and unit mismatch

### Database

- migrate empty PostgreSQL
- foreign key and uniqueness constraints
- immutable observation enforcement through repository API
- concurrent version conflict
- idempotency replay and payload mismatch
- event and domain write atomicity
- stable pagination under concurrent inserts

### API

- schema rejects missing, extra, and malformed fields
- every domain error mapping
- command idempotency
- request ID propagation
- read pagination cursors
- SSE replay, heartbeat, abort, and reconnect

### Web

- populated and empty list states
- project creation validation
- baseline-before-start enforcement
- manual experiment journey
- decision reason rendering
- SSE duplicate suppression and gap reconciliation
- 404 and recoverable error states
- keyboard navigation and focus restoration
- desktop and 390px viewport without horizontal overflow

## 12. Acceptance criteria

Phase 1 is complete only when all are true:

1. A clean PostgreSQL instance migrates from zero using committed SQL.
2. No production path uses `drizzle-kit push`.
3. Current fixture data can be loaded through a development seed command.
4. All Phase 0 screens read from the Hono API.
5. A project and versioned metric can be created through the UI.
6. A run cannot start without a valid baseline and budget.
7. A manual experiment records hypothesis, action, before, and after evidence.
8. Decision output is deterministic and includes a machine-readable reason.
9. Guardrail failure prevents a kept decision.
10. Budget exhaustion prevents another experiment.
11. Duplicate command delivery is idempotent.
12. Stale aggregate versions return a conflict without partial writes.
13. Domain changes and run events commit atomically.
14. SSE reconnect replays all events after the supplied cursor.
15. A learning references durable experiment evidence.
16. Unknown workspace relationships return not found without leaking data.
17. No database type crosses into the web application.
18. No runner, shell executor, or LLM provider exists in the dependency graph.
19. Format, typecheck, lint, unit, integration, end-to-end, and build gates pass.
20. Architecture.md reflects any deviation accepted during implementation.

## 13. Rollout and recovery

- Phase 1 deploys behind `MANUAL_RESEARCH_ENABLED`.
- Database migration runs as a separate release step before application rollout.
- API starts only when schema version is compatible.
- control-plane error boundaries remain the fallback when the API is unavailable
- a failed command is safe to retry with the same idempotency key
- SSE clients always recover from the durable cursor
- rollback never attempts down migrations automatically

## 14. Risks

| Risk                                      | Mitigation                                                |
| ----------------------------------------- | --------------------------------------------------------- |
| Metric decimals lose precision            | Canonical decimal strings and explicit decimal arithmetic |
| Two tabs race lifecycle commands          | Aggregate versions plus row locks                         |
| SSE misses an in-memory notification      | Durable replay plus periodic reconciliation               |
| Web snapshots become stale after commands | Durable SSE invalidation plus explicit route refresh      |
| Manual entry creates incomparable results | Immutable metric protocol version and unit validation     |
| Generic API handlers absorb domain rules  | Use-case tests and dependency-boundary linting            |
| Phase 1 drifts into autonomy              | Dependency audit forbids runner and provider packages     |

## 15. Default decisions requiring no user block

- workspace is seeded and single-tenant until authentication is planned
- source references are descriptive strings; Socrates does not access them
- PostgreSQL 17 or newer is supported without optional extensions
- cost values use integer minor units
- times are UTC `timestamptz`
- IDs are generated through a domain `IdFactory` compatible with UUIDv7
- a manual human may override a deterministic decision only with a reason
- learning confidence starts as explicit user input, not model inference

Any change to these defaults updates Architecture.md before implementation.
