# Phase 1 Acceptance Evidence

Verified: 2026-07-31
Scope: measured manual experiments
Architecture: ADR-010 through ADR-029

This matrix maps every acceptance criterion in
`docs/plans/phase-1-measured-experiments.md` to current authoritative evidence.

| #   | Requirement                                       | Evidence                                                                                                                                    |
| --- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Clean PostgreSQL migrates from zero               | CI PostgreSQL service; `migration.test.ts`; disposable PostgreSQL 17 database migrated through `0004_remove_redundant_evidence_indexes.sql` |
| 2   | No production `drizzle-kit push` path             | Database scripts expose only generate, check, migrate, and seed; repository search contains no `db:push`                                    |
| 3   | Development seed command exists                   | `db:seed-development`; `seed-development.ts`; CI seed step                                                                                  |
| 4   | Every product screen reads from Hono              | Server query boundary in `apps/web/src/lib/api`; fixture-free browser journey                                                               |
| 5   | UI creates projects and versioned metrics         | Chromium journey creates protocol v1, revises to v2, and observes both projections                                                          |
| 6   | Run requires a valid baseline and budget          | Domain lifecycle tests, command integration tests, and browser journey                                                                      |
| 7   | Manual experiment records complete evidence       | Browser journey records hypothesis, action, before, after, and guardrail observations                                                       |
| 8   | Deterministic decision includes a reason          | Domain metric tests; experiment decision projection; automated/final evidence panel                                                         |
| 9   | Hard guardrail failure prevents `kept`            | Domain override tests and command integration rollback test                                                                                 |
| 10  | Exhausted budget prevents another experiment      | `commands.integration.test.ts` asserts `budget_exhausted`                                                                                   |
| 11  | Duplicate commands are idempotent                 | Project replay and concurrent same-key command integration tests                                                                            |
| 12  | Stale versions conflict without partial writes    | Project, run, and experiment conflict integration assertions                                                                                |
| 13  | State and run events commit atomically            | Transaction-only command executor; forbidden override rollback; durable event sequence assertions                                           |
| 14  | SSE reconnect replays after the cursor            | `run-event-stream.test.ts`, read integration SSE test, and live Chromium connection                                                         |
| 15  | Learning references durable experiment evidence   | Learning/evidence foreign keys, command integration assertion, and browser projection                                                       |
| 16  | Workspace boundaries do not leak relationships    | Read integration tests use an isolated workspace and assert not-found responses                                                             |
| 17  | Web imports no database types                     | `audit:phase-1` scans every web source import                                                                                               |
| 18  | No runner, executor, or model provider is enabled | `audit:phase-1` scans production imports and all workspace manifest dependency sections                                                     |
| 19  | Every required quality gate passes                | CI runs format, typecheck, lint, boundary audit, migration, tests, real Chromium, and production build                                      |
| 20  | Architecture reflects implementation decisions    | ADR-010 through ADR-029 and completed feature plans                                                                                         |

## PostgreSQL query-plan evidence

`query-plan.integration.test.ts` runs `EXPLAIN (FORMAT JSON, COSTS OFF)` against
PostgreSQL with sequential and bitmap scans disabled to verify that every
declared ordering contract is executable directly by its B-tree:

- projects: `projects_workspace_created_id_idx`
- runs: `runs_project_created_id_idx`
- experiments: `experiments_run_created_id_idx`
- project learnings: `learnings_project_created_id_idx`
- observation hydration: `observations_experiment_recorded_id_idx`
- decision hydration: `decisions_experiment_created_id_idx`

Those six scoped plans contain no `Sort` node. The workspace learning
projection verifies `learnings_created_id_idx` and
`projects_workspace_created_id_idx`; its cross-project merge may retain a
bounded sort in Phase 1. ADR-028 records why workspace denormalization is
deferred until multi-tenancy.

## Operational evidence

- A disposable PostgreSQL 17 database migrated from zero and contained schema
  compatibility version `1` plus all seven required indexes.
- The built API was started against a disposable database whose marker was
  deliberately changed to version `2`; it exited before listening with an
  expected-version-1 compatibility error.
- Manual command routes return `service_unavailable` unless
  `MANUAL_RESEARCH_ENABLED=true`.
- The browser acceptance test crosses real Next.js, Hono, and PostgreSQL
  boundaries without request interception.
