# OCI engine spike harness

This directory is disposable evaluation code. Nothing under `apps`, `packages`,
or `services` imports it.

## Safety boundary

The harness:

- requires an explicit engine and digest-pinned image;
- invokes engine CLIs without a host shell;
- uses fixed, non-user-authored probe commands;
- applies the ADR-041 default-deny profile;
- labels every object with both `socrates.managed=true` and a unique spike ID;
- removes only objects matching both labels; and
- bounds command time and captured output.

Do not point it at a shared production daemon. The memory, PID, and disk probes
are deliberately finite but are intended for a disposable runner host.

## Commands

```text
pnpm spike:oci:typecheck
pnpm spike:oci:test
pnpm spike:oci -- --engine docker --image <name@sha256:digest>
```

Desktop/WSL evidence requires the explicit
`--allow-development-host` argument. Such evidence can never set
`eligibleForNativeSelection` to true.

```text
pnpm spike:oci -- --engine docker --image <name@sha256:digest> \
  --allow-development-host --latency-samples 30
```

Docker, Podman, and nerdctl share the same adversarial executor. Engine
adapters normalize Docker-compatible and Podman-native fact/inspection fields,
while the fixed command profile records the few intentional CLI differences.
Podman and nerdctl still require live proof on the native Linux reference host
before the engine decision can close.

Evidence is written to `spikes/oci-engine/evidence/<engine>-current-host.json`.
It contains selected version and enforcement facts, not raw environment or
command output.

## Native reference-host rerun

Use a disposable native Linux host with cgroup v2, systemd delegation, AppArmor
or SELinux, and rootless Docker and Podman configured for the same unprivileged
operator. Pre-pull the exact digest for every installed candidate because the
profile disables implicit pulls:

```text
docker pull <name@sha256:digest>
podman pull <name@sha256:digest>
nerdctl pull <name@sha256:digest> # only when nerdctl is installed

pnpm spike:oci:native -- --image <name@sha256:digest> --latency-samples 30
```

The command runs Docker, Podman, and nerdctl sequentially and writes an
immutable directory under `spikes/oci-engine/evidence/native/`. Exit code `0`
means the comparison is ready for architecture review. Exit code `2` means
evidence was still written but at least one fail-closed comparison gate did not
pass. The comparison does not select or rank an engine.
