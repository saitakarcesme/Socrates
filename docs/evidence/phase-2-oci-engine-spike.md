# Phase 2 OCI engine spike evidence

Status: Development-host evidence complete; native selection pending

Date: 2026-07-31

Architecture: ADR-041

## Current host

- Windows with WSL `2.6.3.0`
- WSL kernel `6.6.87.2-microsoft-standard-WSL2`
- Docker Desktop client/server `29.3.1`
- Docker cgroup v2 with `cgroupfs`
- Docker security options: builtin seccomp and private cgroup namespace
- storage driver: `overlayfs`
- Podman: not installed
- nerdctl: not installed

The Docker daemon did not report rootless mode, AppArmor, or SELinux. The host
is therefore development-only under ADR-041 and cannot select the production
engine.

## Immutable input

All executable probes used:

```text
node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
```

The image was pulled before measurement and every measured invocation used the
resolved digest rather than the tag.

## Fixed profile

- memory: 64 MiB
- memory plus swap: 64 MiB
- CPU: 0.5
- maximum PIDs: 32
- root filesystem: read-only
- `/workspace`: 1 MiB tmpfs with `noexec,nosuid,nodev`
- `/tmp`: 256 KiB tmpfs with `noexec,nosuid,nodev`
- network: none
- user: `65534:65534`
- capabilities: all dropped
- no-new-privileges: enabled
- devices and host/runtime socket mounts: none

Docker inspect confirmed every requested fixed-profile field. The container
also observed delegated CPU, memory, and PID controllers.

## Adversarial results

| Gate                         | Result | Observation                                            |
| ---------------------------- | ------ | ------------------------------------------------------ |
| delegated cgroup controllers | pass   | CPU, memory, and PID controllers visible               |
| host mount and privilege     | pass   | zero effective caps; mount and namespace gain denied   |
| fixed profile inspection     | pass   | requested isolation and resource fields active         |
| DNS and direct-IP network    | pass   | both failed under the unconfigured namespace           |
| host secrets                 | pass   | sentinel and standard credential paths absent          |
| workspace disk fill          | pass   | ENOSPC within the 1 MiB tmpfs bound                    |
| PID pressure                 | pass   | child creation rejected below the 32-process bound     |
| memory pressure              | pass   | engine reported `OOMKilled`                            |
| TERM-resistant cancellation  | pass   | hard stop completed in approximately 1.1 seconds       |
| label-scoped cleanup         | pass   | no `socrates.managed` container remained after the run |

The tests intentionally allocate only inside declared cgroups. They do not run
an unbounded host fork bomb or disk fill.

## Cached-image latency

After five warm-up iterations, 30 run-and-remove samples produced:

- median: `256.92 ms`
- p95: `284.24 ms`
- maximum: `296.57 ms`

These numbers include Docker Desktop/WSL overhead and are not production
capacity estimates.

## Candidate comparison

| Candidate           | Current evidence | Selection status                                    |
| ------------------- | ---------------- | --------------------------------------------------- |
| Docker Desktop/WSL  | 8/8 gates pass   | ineligible: not native Linux, rootless, or host LSM |
| rootless Docker     | not run          | pending native Linux reference host                 |
| rootless Podman     | unavailable      | pending installation on reference host              |
| rootless containerd | unavailable      | pending installation on reference host              |

## Decision

No engine is selected. Promoting Docker Desktop evidence would violate ADR-041
and conceal missing rootless/LSM guarantees. Slice 2.5 remains gated on a
native Linux rerun with at least Docker and Podman; nerdctl remains a candidate
if its full executor adapter and dependencies are provisioned on that host.

Machine-readable evidence:

- `spikes/oci-engine/evidence/docker-current-host.json`
- `spikes/oci-engine/evidence/podman-current-host.json`
- `spikes/oci-engine/evidence/nerdctl-current-host.json`
