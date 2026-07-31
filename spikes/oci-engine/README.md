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

Podman and nerdctl currently record availability only. Their executor adapters
must be implemented and proven on the native Linux reference host before the
engine decision can close.

Evidence is written to `spikes/oci-engine/evidence/<engine>-current-host.json`.
It contains selected version and enforcement facts, not raw environment or
command output.
