# Phase 2 OCI engine spike evidence

Status: Native comparison complete; rootless containerd selected

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
- `/dev/shm`: 64 KiB with no implicit extra writable tmpfs mounts
- network: none
- user: `65534:65534`
- capabilities: all dropped
- no-new-privileges: enabled
- devices and host/runtime socket mounts: none
- implicit image pulls and daemon log storage: disabled

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

- median: `244.21 ms`
- p95: `297.81 ms`
- maximum: `297.99 ms`

These numbers include Docker Desktop/WSL overhead and are not production
capacity estimates.

## Candidate comparison

The final native session ran on a fresh Ubuntu 24.04 GitHub-hosted VM with
kernel `6.17.0-1020-azure`, systemd cgroup v2, rootless engines, and enforcing
AppArmor. All candidates used the same immutable image and fixed profile.

| Candidate                         | Security result                                                    | 30-sample latency (median / p95) | Decision   |
| --------------------------------- | ------------------------------------------------------------------ | -------------------------------- | ---------- |
| Docker Desktop/WSL development    | development gates pass; native/rootless/host-LSM preflight fails   | 244.21 / 297.81 ms               | ineligible |
| Docker 29.7.0 rootless            | workload `rootlesskit (unconfined)`; sandbox LSM gate fails        | 181.03 / 192.37 ms               | rejected   |
| Podman 4.9.3 rootless             | workload `crun (unconfined)`; LSM and inspect proof gates fail     | 128.73 / 141.26 ms               | rejected   |
| containerd/nerdctl 2.3.1 rootless | 8/8 preflight, 9/9 adversarial, cancellation, and 9/9 cleanup pass | 185.91 / 196.37 ms               | selected   |

The comparison manifest passed all six comparability/review gates. nerdctl's
maximum cached run-and-remove measurement was `199.99 ms`; hard cancellation
completed in `1064.58 ms`.

## Decision

ADR-041 selects rootless containerd through nerdctl v2.3.1 for Slice 2.5.
Selection is based on enforcement, not speed: the selected candidate applied
the preloaded `socrates-sandbox` AppArmor profile, reported the exact enforcing
label, denied the profile-specific write probe, and exposed the requested
controls in its native OCI spec.

Docker and Podman are not fallbacks. Both completed measurement, cancellation,
and cleanup, but neither confined the workload with the required LSM on the
reference host. The future adapter must be implemented anew around nerdctl,
must repeat startup self-checks, and must fail closed if its pinned engine
family, rootless state, cgroup delegation, seccomp, AppArmor profile, or native
OCI inspection is absent.

Machine-readable evidence:

- `spikes/oci-engine/evidence/docker-current-host.json`
- `spikes/oci-engine/evidence/podman-current-host.json`
- `spikes/oci-engine/evidence/nerdctl-current-host.json`
- `spikes/oci-engine/evidence/native/2026-07-31T03-45-02-824Z-8be04f01/comparison.json`
- `spikes/oci-engine/evidence/native/2026-07-31T03-45-02-824Z-8be04f01/docker.json`
- `spikes/oci-engine/evidence/native/2026-07-31T03-45-02-824Z-8be04f01/podman.json`
- `spikes/oci-engine/evidence/native/2026-07-31T03-45-02-824Z-8be04f01/nerdctl.json`
