# Phase 1 Acceptance Hardening

Status: Completed
Owner: Socrates core
Architecture decisions: ADR-028, ADR-029

## Outcome

Phase 1 closes its remaining operational acceptance gaps with query-plan
evidence, explicit command rollout control, startup schema compatibility, and a
requirement-by-requirement evidence audit.

## Work

1. Add cursor-order and evidence-hydration indexes.
2. Generate and review the forward-only Drizzle migration.
3. Assert required index definitions in database tests.
4. Add the schema compatibility marker and startup check.
5. Gate command routes behind `MANUAL_RESEARCH_ENABLED`.
6. Audit production sources and manifests for executors and model providers.
7. Verify critical query plans on PostgreSQL 17.
8. Publish the Phase 1 acceptance evidence matrix.
9. Run the full static, PostgreSQL, Chromium, and production-build gates.

## Non-goals

- multi-workspace query denormalization
- automatic migration on API startup
- a remote feature-flag provider
- runner or provider enablement

## Acceptance

- command routes are unavailable unless explicitly enabled
- a configured API refuses to listen against an incompatible schema
- required pagination indexes match equality scope and stable ordering
- clean migration, seed, test, browser, and build workflows pass
- every Phase 1 acceptance criterion links to authoritative evidence

Evidence: `docs/evidence/phase-1-acceptance.md`
