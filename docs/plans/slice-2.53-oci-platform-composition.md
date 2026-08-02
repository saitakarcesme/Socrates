# Slice 2.53 OCI platform composition

Status: Planned

Date: 2026-08-02

Architecture: ADR-044, ADR-086, ADR-089, ADR-090

## Outcome

Compose the admitted local-runner and trusted-image snapshots into one inert OCI
platform graph. The graph captures explicit capabilities and exposes only the
ports needed by the existing attempt lifecycle. It does not construct system
adapters, start a process, or activate the runner.

## Admission order

`LocalRunnerOciPlatform` accepts:

- unknown ADR-086 local-runner configuration;
- unknown ADR-089 trusted-image catalog configuration;
- one `ProcessExecutor`;
- one `HostReadinessInspector`;
- one epoch-millisecond clock;
- one ephemeral probe-identity source.

The local-runner candidate is parsed first. Trusted images are parsed second.
Only then may dependency owners or methods be read. Malformed configuration or
images cannot read a capability getter, reveal a dependency value, or cause a
file, environment, process, clock, identity, host, image, readiness, sandbox,
or network effect.

## Resource graph

The captured dependencies construct exactly one of each existing resource:

1. `NerdctlReadinessVerifier`;
2. `NerdctlSandboxBackend`;
3. `NerdctlImageInspector`;
4. `NerdctlImageHandshakeVerifier`;
5. `SandboxImageCatalog`.

The readiness verifier, backend, and image inspector share one captured process
executor and the exact configured engine executable. Readiness and backend
share one validated epoch clock. The backend and handshake verifier share one
validated ephemeral identity source. The catalog shares the inspector and the
handshake verifier backed by that same backend.

No component may use its constructor default for executable, timeout, output
bytes, clock, identity, runner ownership, deployment ownership, or protocol
frame bounds inside this graph.

## Exact mapping

- readiness: engine executable, control timeout, control output ceiling, epoch
  clock converted to `Date`;
- backend: deployment ID, runner ID, engine executable, readiness TTL, control
  timeout, execution timeout, control output ceiling, execution runtime-output
  ceiling, epoch clock, and ephemeral identity source;
- inspector: engine executable, control timeout, and control output ceiling;
- handshake: backend, runner ID, derived probe profile, protocol frame ceiling,
  and ephemeral identity source;
- catalog: detached trusted-image declarations, inspector, and handshake.

The probe profile is a deeply frozen pure derivation:

- `memoryBytes = execution.maximumMemoryBytes`;
- `cpuCount = execution.minimumCpuQuotaMicros / execution.cpuQuotaPeriodMicros`;
- `maximumPids = execution.maximumPids`;
- `temporaryBytes = execution.temporaryBytes`;
- `sharedMemoryBytes = execution.sharedMemoryBytes`;
- `workspaceBytes = execution.maximumWritableBytes - temporaryBytes - sharedMemoryBytes`.

ADR-086 already proves the workspace remainder positive and the runtime output
authority large enough for the protocol frame ceiling.

## Public surface

The frozen platform exposes only:

- `admit(manifestDigest, architecture)`;
- `recoverOwned()`;
- `cancel(identity, reason)`;
- `executeRuntime(input)`.

Methods are retained bindings. Later mutation of any input object or method
cannot redirect work. Configuration, declarations, dependencies, component
instances, readiness invalidation, inspection, handshake, and attestation are
not publicly exposed.

## Failure contract

Construction exposes fixed frozen errors only:

- `invalid_configuration`;
- `invalid_images`;
- `invalid_dependency`;
- `composition_failed`.

Messages contain no candidate value, image declaration, executable, path,
environment entry, identity, dependency, cause text, or process output. Once an
operation begins, existing catalog and backend failure contracts remain
authoritative.

## Adversarial matrix

- invalid local configuration wins before image and dependency getters;
- invalid image configuration wins before dependency getters;
- missing, non-callable, accessor, throwing, stateful, or later-mutated
  dependency methods;
- invalid, throwing, repeated, and later-mutated clock results;
- malformed, duplicate, throwing, and later-mutated ephemeral identities;
- exact engine executable, timeout, TTL, and output mapping;
- exact deployment/runner ownership and protocol frame mapping;
- exact probe-profile derivation at minimum and maximum admitted CPU ratios;
- catalog admission proves inspector, handshake, and backend sharing;
- sandbox recovery/runtime operations prove backend binding;
- repeated/concurrent operations retain one component graph;
- fixed-error serialization reveals no candidate or dependency values;
- construction invokes no dependency method and produces no external effect;
- system adapters, lifecycle, entry point, feature flag, and activation remain
  absent.

## Delivery order

1. Commit ADR-090 and this plan before production code.
2. Add explicit ephemeral-identity injection to backend and handshake probes
   while preserving existing direct-constructor compatibility.
3. Add the pure policy derivation and opaque OCI platform composition.
4. Add adversarial ordering, capture, mapping, sharing, mutation, redaction,
   and inertness tests.
5. Audit that no concrete system adapter, loader, lifecycle, process entry,
   shutdown owner, feature flag, or activation landed.
6. Run every local and GitHub Actions gate before admitting ADR-090.

## Exit criteria

1. Both unknown-data boundaries win before every dependency read or effect.
2. One captured process, host, clock, and identity authority owns the graph.
3. Every admitted engine and probe-profile value has one exact mapping.
4. Image catalog and sandbox operations share one backend graph.
5. Construction is inert, opaque, immutable, deterministic, and redacted.
6. No system adapter, loader, lifecycle, entry point, shutdown owner, feature
   flag, or runner activation lands.
