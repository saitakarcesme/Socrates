# Slice 2.49 strict local runner configuration snapshot

Status: Admitted

Date: 2026-08-02

Architecture: ADR-056, ADR-080, ADR-082, ADR-084, ADR-085, ADR-086

## Outcome

Create the first complete, strict, non-secret data contract from which a later
local-runner resource graph can be built without duplicated authority.

## Configuration boundary

`parseLocalRunnerConfiguration(candidate)` accepts unknown input and returns a
deeply frozen `LocalRunnerConfigurationV1`. The parser performs no I/O and
retains no reference from the candidate.

The V1 snapshot groups:

- `identity`: constrained deployment identifier and exact runner UUID;
- `controlPlane`: HTTPS origin plus bounded request/response timing and bytes;
- `roots`: canonical artifact, source, journal, and spool POSIX roots;
- `engine`: executable, readiness lifetime, control/execution timeouts, and
  output bounds;
- `source`: one archive authority plus extraction/path/accounting bounds;
- `request`: runtime request byte bound;
- `runtime`: protocol and child-output byte bounds;
- `execution`: the complete admitted local execution policy;
- `durability`: journal and spool limits;
- `lifecycle`: lease, heartbeat, revocation, recovery, and poll bounds.

No token, credential, environment map, secret reference, catalog contents,
function, clock, scheduler, observer, signal, or constructed capability is part
of the contract.

## Single-authority rules

- runner identity and engine executable occur once;
- `source.maximumArchiveBytes` configures future transport download, artifact
  admission, and extraction bounds;
- `execution.maximumRuntimeOutputBytes` is the outer runtime output authority;
- lifecycle durations occur only in `lifecycle`;
- every private durable root occurs only in `roots`;
- aliases and legacy duplicate fields are rejected as unknown keys.

## Relational validation

- the control-plane URL is an HTTPS origin only;
- roots are absolute, canonical, distinct, and pairwise non-nested;
- heartbeat interval is shorter than lease duration;
- revocation grace does not exceed lease duration;
- source file bytes do not exceed expanded bytes;
- runtime protocol and child-output bounds do not exceed execution output;
- journal/spool per-item limits fit their respective total budgets;
- all required numeric limits are safe integers with explicit positive or
  non-negative semantics.

## Adversarial matrix

- null, arrays, primitives, proxies, throwing getters, and exotic prototypes;
- missing and extra keys at every object level;
- malformed version, deployment identifier, UUID, executable, and URL;
- URL credentials, HTTP, paths, queries, fragments, and encoded ambiguity;
- relative, non-canonical, equal, ancestor, descendant, and NUL-bearing roots;
- zero, negative, fractional, infinite, unsafe, and excessive integers;
- every cross-field equality and one-unit boundary;
- secret-like/token/environment/function/signal fields rejected;
- caller mutation before and after parsing cannot alter the result;
- nested objects are plain, exact, and deeply frozen;
- repeated parse is deterministic and creates independent snapshots;
- construction and parsing perform no filesystem, network, process, clock, or
  environment effect.

## Delivery order

1. Commit ADR-086 and this plan before production code.
2. Add the strict V1 schema and parser in a dedicated configuration module.
3. Export only the parser and immutable data types.
4. Add table-driven boundary and property-based relational tests.
5. Audit that no environment, credential, or resource dependency landed.
6. Run every local and GitHub Actions gate before admitting ADR-086.

## Exit criteria

1. Every future concrete resource input has one unambiguous non-secret source.
2. Invalid configuration fails before any external effect.
3. Accepted configuration is exact, detached, plain, and deeply immutable.
4. Cross-resource identity, byte, path, and cadence authority cannot drift.
5. No credential or process environment is accepted or retained.
6. No resource construction, entry point, shutdown owner, or runner enablement
   lands.

## Admission evidence

- Architecture commit: `a8900ba`.
- Implementation commit: `0f3270e`.
- Focused suite: 75 adversarial and property-based parser tests covering plain
  data admission, missing and unknown keys at every level, secret/process
  authority rejection, identity and string bounds, exact HTTPS origins,
  canonical disjoint roots, every numeric authority, relational one-unit
  boundaries, caller detachment, deep freezing, deterministic parsing, fixed
  public errors, and retained diagnostics without secret-value echo.
- Runner-local suite: all 1019 tests passed against fresh migrated PostgreSQL
  database `socrates_ci_adr086`.
- Local gates: Phase 1 and Phase 2 boundary audits, formatting, typecheck,
  lint, full workspace tests, database and API integrations, Chromium
  measured-research E2E, and production build. Native durability validations
  are Linux-only and passed in CI.
- GitHub Actions: run `30726331992` passed all required Linux, PostgreSQL, API,
  runner, native durability, Chromium journey, production-build, and
  evidence-upload gates.
