# OCI engine spike plan

Status: Blocked on native Linux reference-host evidence

Date: 2026-07-31

Architecture decision: ADR-041

## Purpose

Select an OCI backend for the future guarded local runner by measured
enforcement, cancellation, cleanup, and latency evidence. This spike does not
execute user experiments and is not production runner code.

## Candidates

| Candidate            | Required mode          | Current Windows host |
| -------------------- | ---------------------- | -------------------- |
| Docker Engine        | native Linux, rootless | Desktop/WSL only     |
| Podman               | native Linux, rootless | not installed        |
| containerd + nerdctl | native Linux, rootless | not installed        |

The current host can produce Docker Desktop development evidence. Final
selection requires all passing candidates to be rerun on the same native Linux
reference host.

## Primary-source findings

- OCI isolation depends on Linux namespaces, cgroups, capabilities, LSMs,
  filesystem confinement, and seccomp rather than the OCI file format alone:
  <https://github.com/opencontainers/runtime-spec/blob/main/config-linux.md>
- Docker rootless mode runs the daemon and containers inside a user namespace:
  <https://docs.docker.com/engine/security/rootless/>
- Docker rootless resource flags require cgroup v2 and systemd delegation and
  may otherwise be ignored:
  <https://docs.docker.com/engine/security/rootless/tips/>
- Docker containers are unlimited by default; memory and CPU limits must be
  explicit:
  <https://docs.docker.com/engine/containers/resource_constraints/>
- Docker's default seccomp profile is an allowlist and must remain enabled:
  <https://docs.docker.com/engine/security/seccomp/>
- Podman supports rootless user namespaces and reports its cgroup and security
  state through `podman info`:
  <https://docs.podman.io/en/latest/markdown/podman.1.html> and
  <https://docs.podman.io/en/stable/markdown/podman-info.1.html>
- Podman exposes the required network-none, read-only, memory, PID, and tmpfs
  controls:
  <https://docs.podman.io/en/latest/markdown/podman-run.1.html>
- nerdctl supports rootless containerd, cgroup controls, seccomp/AppArmor,
  no-new-privileges, and capability removal:
  <https://github.com/containerd/nerdctl> and
  <https://github.com/containerd/nerdctl/blob/main/docs/command-reference.md>
- Docker Desktop WSL uses a Linux VM but host files remain reachable through
  WSL sharing; stricter production isolation requires a different host
  assumption:
  <https://docs.docker.com/desktop/features/wsl/>

## Host preflight gates

The harness records versioned facts and rejects the target unless all required
facts are observable:

1. Linux native production host; Desktop/WSL is marked development-only.
2. Rootless engine and user namespace enabled.
3. Cgroup v2 with delegated `cpu`, `memory`, and `pids` controllers.
4. Seccomp enabled with no unconfined override.
5. AppArmor or SELinux enabled on the native reference host.
6. Private PID, IPC, mount, user, cgroup, and network namespaces.
7. Engine supports a non-root user, all-capability drop,
   no-new-privileges, read-only rootfs, bounded tmpfs, and explicit resource
   limits.

## Fixed sandbox profile

- image pinned by digest
- no shell interpolation; argument arrays only
- `--network none`
- `--read-only`
- `/workspace` backed by size-bounded tmpfs
- `/tmp` backed by a smaller size-bounded tmpfs
- `/dev/shm` bounded explicitly and engine-added writable tmpfs mounts disabled
- non-root UID/GID
- all Linux capabilities dropped
- no-new-privileges enabled
- default seccomp and host LSM enabled
- memory and swap equal, CPU quota, and PID limit set
- no devices, privileged mode, host namespace, runtime socket, or broad bind
  mounts
- explicit empty environment plus a minimal allowlist
- unique `socrates.spike.id` and `socrates.managed=true` labels
- digest-pinned image already present with implicit pulls and daemon logs
  disabled

## Adversarial matrix

| Gate           | Probe                                                     | Pass condition                           |
| -------------- | --------------------------------------------------------- | ---------------------------------------- |
| host mounts    | read common host paths and runtime sockets                | absent or permission denied              |
| privilege      | inspect capabilities; attempt setuid/mount/namespace gain | no effective caps; operations denied     |
| network        | DNS and direct-IP TCP attempts                            | both fail                                |
| PID            | bounded child-process fan-out                             | cgroup limit reached; host stays healthy |
| memory         | bounded allocation beyond limit                           | container OOM/fails; host stays healthy  |
| writable bytes | fill `/workspace` beyond tmpfs size                       | ENOSPC before declared bound is exceeded |
| secrets        | scan environment and standard credential locations        | only explicit harmless variables visible |
| cancellation   | ignore TERM and retain child process                      | hard kill removes all owned processes    |
| cleanup        | enumerate by unique labels after every outcome            | no container/network/mount remains       |

Probes use finite allocations and timeouts. The spike must not intentionally
stress the host outside the candidate's declared cgroup.

## Latency method

1. Pin one small public image by digest and pre-pull it outside the measured
   interval.
2. Run five warm-up iterations.
3. Record at least 30 cached-image iterations for:
   - create to started;
   - started to exited; and
   - create through forced removal.
4. Report median, p95, maximum, engine/runtime versions, kernel, cgroup mode,
   storage driver, and Desktop/native classification.
5. Never trade a failed enforcement gate for lower latency.

## Deliverables

- engine-neutral TypeScript spike harness outside production workspaces
- machine-readable JSON evidence with command output redacted
- human-readable comparison and limitations
- native Linux rerun command that writes an immutable session directory and a
  fail-closed comparison manifest
- ADR amendment selecting one engine or explicitly recording that selection is
  blocked pending native-host evidence

## Native comparison session

The reference host runs Docker and Podman sequentially in one harness process.
nerdctl is included when it is available. Each engine receives the same
digest-pinned image, fixed profile, warm-up count, and latency sample count.
Evidence is written under a unique session directory rather than replacing
development-host evidence.

The comparison manifest is review-ready only when:

1. Docker and Podman both produced complete evidence.
2. Both required candidates are eligible for native selection.
3. Their image, fixed profile, kernel, architecture, and cgroup version match.
4. Every requested optional candidate either produced evidence or is recorded
   as unavailable; optional failure cannot be mistaken for required success.

The manifest never chooses the lowest-latency engine. Enforcement evidence and
an explicit ADR review remain authoritative.

## Promotion rule

The harness and its command builders are disposable. Slice 2.5 begins with a
new plan and typed runner adapter after the engine decision is reviewed.

## Current-host result

The Docker Desktop development run passed all eight adversarial enforcement
gates, hard cancellation, label-scoped cleanup, and 30 latency samples. It
failed the native Linux, rootless, and host-LSM preflight gates exactly as
expected. The typed executor and fact normalization now cover Docker, Podman,
and nerdctl, but the latter two are not installed on this host. No engine is
selected and Slice 2.5 remains gated. The native session command and
fail-closed comparison manifest are implemented; see
`docs/evidence/phase-2-oci-engine-spike.md`.
