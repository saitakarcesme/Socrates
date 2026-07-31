# Slice 2.5 guarded OCI adapter plan

Status: Approved for implementation

Date: 2026-07-31

Architecture: ADR-032, ADR-033, ADR-041, ADR-042

## Outcome

Build the production-quality, fail-closed rootless containerd boundary selected
by ADR-041. This slice proves that Socrates can attest the host, create one
owned sandbox with typed nerdctl arguments, verify the native OCI spec before
work starts, terminate it within a bound, and clean up only its own objects.

This is not yet a complete executable `Runner`. The current task contract
identifies a source snapshot and image by digest but does not grant safe access
to snapshot bytes or prove that an image implements a Socrates runtime ABI.
Those missing capabilities are explicit prerequisites, not invitations to use
an arbitrary host path or shell.

## Package boundary

Production code belongs in `services/runner-local/src/oci`:

- `process.ts`: injected no-shell process port, bounded capture, typed failures;
- `identity.ts`: hashed names and exact Socrates ownership labels;
- `readiness.ts`: cached startup attestation with explicit invalidation;
- `profile.ts`: trusted limits and typed nerdctl argv construction;
- `native-spec.ts`: strict parsing and verification of runtime-facing OCI data;
- `backend.ts`: create, inspect, start/wait, cancel, remove, and recover;
- `index.ts`: narrow exports for the OCI boundary.

The spike remains outside the workspace packages and is never imported.
Production builders are written from ADR-042 requirements and independently
tested.

## Public model

`NerdctlSandboxBackend` accepts only validated internal values:

- an attempt identity: runner ID, task ID, attempt ID, and positive fence;
- an admitted digest-pinned image capability;
- an optional materialized source capability owned by the same attempt;
- a non-shell absolute executable plus argument array;
- requested resource limits already capped by trusted runner policy;
- an abort signal and bounded cancellation grace period.

The first implementation exposes the low-level backend types needed by native
verification. It must not export a constructor that accepts raw bind paths,
unvalidated labels, shell text, engine names, or arbitrary security options.
The main package `Runner` interface remains unchanged and
`LocalRunnerNotEnabledError` remains truthful.

## Readiness gates

Before any create operation, one attestation must prove:

1. `process.platform` is Linux and the runner UID is non-root.
2. `nerdctl version` is parseable and the client is in the selected `2.3.x`
   family.
3. `nerdctl info` reports rootless containerd.
4. cgroup v2 is active and CPU, memory, and PID controllers are delegated.
5. seccomp and AppArmor are available.
6. the `socrates-sandbox` profile is loaded in enforce mode.
7. a harmless, already-present admitted fixture can be created and inspected
   through `inspect --mode native` when the native workflow requests the deep
   probe.

The attestation result contains structured facts and a timestamp. It is valid
only for a short trusted configuration interval and is invalidated by process
errors that indicate loss of engine connectivity or enforcement support.
Readiness never installs, starts, pulls, or modifies host policy.

## Fixed sandbox construction

The argv builder always specifies:

- `create`, a hashed name, and exact deployment/runner/attempt ownership labels;
- `--pull never` and the admitted `name@sha256:...` reference;
- `--network none`, private IPC and cgroup namespaces;
- `--read-only`, bounded `/workspace`, `/tmp`, and `/dev/shm` tmpfs;
- UID/GID `65534:65534`;
- `--cap-drop ALL`;
- `--security-opt no-new-privileges`;
- `--security-opt apparmor=socrates-sandbox`;
- memory with swap equal to memory, CPU quota, and PID limit;
- `--log-driver none`;
- only `SOCRATES_SANDBOX=1`;
- an absolute executable and discrete arguments.

No generic "extra args" escape hatch exists. Values receive both schema and
trusted-policy validation before conversion to decimal argv.

## Native OCI verification

After `create` and before `start`, the backend parses
`nerdctl inspect --mode native`. Verification requires:

- the expected AppArmor profile and `noNewPrivileges: true`;
- empty bounding, effective, inheritable, permitted, and ambient capability
  sets;
- non-root process identity and the exact explicit environment;
- private mount, PID, IPC, user, cgroup, and network namespaces;
- read-only root and only the expected writable tmpfs mounts;
- memory/swap, CPU, and PID limits equal to the accepted profile;
- no devices, privileged annotations, runtime socket, or unexpected bind;
- the exact admitted image digest and complete ownership labels.

Unknown or missing security-relevant fields fail closed. A verifier test fixture
must include mutations for every checked field.

## Lifecycle and cancellation

The backend owns an in-memory registry keyed by the full attempt identity. It
registers a container after successful creation and before inspection.
Duplicate active identities fail; a different fence is distinct and cannot be
cancelled by the old fence.

Execution proceeds `create -> native inspect -> start --attach -> wait/remove`.
Every phase has a deadline and observes `AbortSignal`. Output capture is byte
bounded even though daemon logging is disabled. A cancellation sends a bounded
graceful stop, then kill and forced remove. Cleanup runs in `finally` and exact
not-found results are idempotent; permission, connectivity, and label mismatch
errors remain visible.

Recovery lists containers using both deployment and runner ownership filters,
then verifies every expected label before removal. It never uses `system prune`,
an empty filter, a task-only filter, or caller-provided labels.

## Test ladder

1. Unit: identity stability and collision-resistant label/name format.
2. Unit: readiness parsing and every fail-closed gate.
3. Unit: exact argv snapshots and rejection of unsafe/unsupported input.
4. Unit: native OCI verification plus one mutation per invariant.
5. Unit: lifecycle ordering, abort races, TERM-to-KILL escalation, idempotent
   removal, and scoped recovery through a scripted process fake.
6. Workspace: typecheck, lint, unit tests, boundary audits, build, format, and
   dependency audit.
7. Native Ubuntu: provision the selected rootless backend and policies, use the
   immutable fixture digest, and prove ready/create/inspect/start/cancel/cleanup.

The native job is manual-only until it has no secret-bearing inputs and no
untrusted workflow trigger. It uploads structured evidence even on failure.

## Follow-on slices

- 2.6: content-verified `SourceSnapshotMaterializer` and safe archive policy;
- 2.7: admitted image catalog plus `socrates.task-runtime.v1` image ABI;
- 2.8: `RunnerExecutionV1` lifecycle adapter, bounded log framing, measurement
  parsing, durable spool, and event acknowledgements;
- 2.9: authenticated outbound transport, lease polling, heartbeat, durable
  cancellation observation, and restart reconciliation.

Network allowlists, credentials, accelerators, artifacts, cloud/distributed
runners, and autonomous experiment generation remain outside Slice 2.5.

## Completion criteria

Slice 2.5 is complete only when:

- the production package contains no spike import or shell invocation;
- readiness fails closed on every missing prerequisite;
- native OCI inspection precedes sandbox start;
- cancellation and recovery can affect only exact Socrates-owned objects;
- ordinary tests remain engine-independent;
- a clean selected-host native run produces reviewable evidence;
- Architecture.md and this plan match the shipped boundary.
