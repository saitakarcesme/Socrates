# Slice 2.52 trusted image catalog configuration

Status: Admitted

Date: 2026-08-02

Architecture: ADR-044, ADR-086, ADR-088, ADR-089

## Outcome

Create the strict unknown-data boundary required before trusted image and OCI
resources can join the local runner graph. The result is one detached, deeply
frozen V1 catalog snapshot with one digest authority per image and no loader or
platform effect.

## Contract

`parseLocalRunnerTrustedImageCatalogConfiguration(candidate)` accepts only:

- a closed `{ version: "1", images }` root;
- one to 32 image declarations;
- one lowercase bare SHA-256 manifest digest per declaration;
- an admitted OCI or Docker V2 manifest media type;
- exact configuration, runtime-build, and runtime-bundle digests;
- `amd64` or `arm64` for the fixed Linux platform;
- bounded absolute runtime and profile-probe commands;
- bounded, ordered, unique, non-secret environment defaults.

The admitted image type has one `digest`; the catalog derives its inspection
reference and expected manifest identity from that same value. `reference`,
`manifestDigest`, tags, registry names, local names, ABI aliases, unknown keys,
and fallback entries are rejected.

## Plain-data admission

Extract one shared structural traversal utility from ADR-086. ADR-086 continues
to reject arrays exactly as before. The new catalog mode accepts only dense
plain arrays and rejects holes, extension keys, custom prototypes, accessors,
symbols, functions, cycles, excessive depth, and excessive nodes. Proxy or
reflection failure is normalized without reading an accessor value.

Field, list, UTF-8 byte, aggregate byte, depth, and node ceilings are explicit
exported constants. Every accepted value is rebuilt by the schema and deeply
frozen. No input object or array identity survives parsing.

The V1 ceilings are:

- 32 nested containers and 10,000 visited structural nodes;
- 4,096 UTF-8 bytes per executable or argument;
- 128 arguments and 65,536 aggregate UTF-8 command bytes;
- 128 environment entries, 8,192 UTF-8 bytes per entry, and 262,144 aggregate
  UTF-8 environment bytes.

## Failure contract

`LocalRunnerTrustedImageConfigurationError` exposes only:

- `invalid_candidate` for unsafe structural data;
- `invalid_configuration` for a structurally safe value outside the closed
  V1 contract.

Messages are fixed and never include a candidate field, environment value,
digest, executable, argument, or cause text. No partial snapshot is returned.

## Adversarial matrix

- null, primitive, array, non-V1, missing, and unknown root fields;
- custom object/array prototypes, accessors, setters, symbols, functions,
  cycles, holes, extension keys, throwing proxies, depth, and node bombs;
- empty and oversized catalogs, duplicate digest identity, aliases, tags, and
  registry-qualified references;
- malformed, uppercase, truncated, and oversized digests;
- unsupported manifest media type, architecture, or platform-like alias;
- relative, empty, dot-segment, NUL, oversized executable and arguments;
- oversized argument count and aggregate command data;
- malformed, duplicate, credential-like, NUL, oversized, and aggregate-
  oversized environment entries;
- post-parse mutation of every source array/object and independent repeated
  parses;
- parser and error serialization reveal no sensitive candidate values;
- accepted output constructs the existing inert `SandboxImageCatalog` without
  a later configuration failure;
- no file, environment, stdin, network, process, clock, UUID, inspection,
  handshake, readiness, image, or sandbox effect.

## Delivery order

1. Commit ADR-089 and this plan before production code.
2. Extract the shared plain-data traversal without changing ADR-086 behavior.
3. Add the V1 catalog schema, exported policy bounds, parser, and fixed errors.
4. Refactor `TrustedSandboxImage` and catalog internals to one digest field.
5. Add adversarial, boundary, property, mutation, redaction, and downstream-
   compatibility tests.
6. Audit that no loader, platform resource, process entry, shutdown owner,
   feature flag, or activation landed.
7. Run every local and GitHub Actions gate before admitting ADR-089.

## Exit criteria

1. Unsafe structure fails before schema field access or every external effect.
2. One digest is the only image/manifest identity authority.
3. The accepted snapshot is exact, detached, deeply frozen, and bounded.
4. Every currently admitted catalog constructor rule is enforced outside the
   future platform graph.
5. Failures are fixed and do not echo candidate data.
6. No loader, inspection, handshake, process/OCI composition, entry point,
   shutdown owner, feature flag, or runner enablement lands.

## Admission evidence

Architecture commit `c27534b` and bounding commit `87f9519` preceded production
code. Implementation commit `8b950d6` delivered the shared structural
admission, strict V1 parser, one-digest trusted declarations, and inert catalog
compatibility.

The final local pass covered 53 trusted-image parser tests, nine catalog tests,
the preserved 78-test ADR-086 configuration suite, all 1,138 runner-local
tests, formatting, types, lint, both architecture audits, the production build,
and the Chromium measured project-to-learning journey against fresh migrated
PostgreSQL databases. Main CI run `30730132598` passed every required Linux,
PostgreSQL, API, runner, native durability, Chromium journey,
production-build, and evidence-upload gate. No loader, OCI/platform resource,
process entry, shutdown owner, feature flag, or runner activation landed.
