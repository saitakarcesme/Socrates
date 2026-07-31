# Slice 2.6 source snapshot materializer evidence

Status: Complete

Date: 2026-07-31

Architecture: ADR-043

## Native run

- GitHub Actions run: `30605900587`
- commit: `d0db70c4033f89db24b8f2d29043f49029176c37`
- host class: GitHub-hosted Ubuntu 24.04 VM
- client: nerdctl `2.3.1`
- server: rootless containerd `v2.3.1`
- architecture: `amd64`
- cgroup: v2
- security options: AppArmor, builtin seccomp, private cgroup namespace,
  rootless
- image:
  `node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32`

The focused reference-host mode skipped the already-admitted three-engine
comparison while retaining pinned provisioning, dependency installation,
native host checks, AppArmor loading, rootless containerd, and immutable image
pre-pull.

## Source snapshot

- archive digest:
  `sha256:f2917deea5251566c6ed38719b4b8550507318b520e7e6cc26a1660d912f6920`
- archive bytes: `2048`
- expanded bytes: `18`
- admitted entries: `1`

The archive contained one regular file below an implicit nested directory. The
artifact store reverified its digest and size while streaming. The materializer
validated POSIX tar framing and entry policy, published the private tree, and
issued a same-attempt capability without exposing a host path.

## Result

| Gate                                      | Result |
| ----------------------------------------- | ------ |
| runner-scoped OCI recovery before run     | pass   |
| source-scoped recovery before run         | pass   |
| archive digest and size reverified        | pass   |
| opaque same-attempt capability            | pass   |
| task digest matched before host execution | pass   |
| create before native inspection           | pass   |
| native OCI source-bind verification       | pass   |
| nested source readable in sandbox         | pass   |
| recursive source write rejected           | pass   |
| exact source release                      | pass   |
| bounded execution                         | pass   |
| exact-fence cancellation                  | pass   |
| final owned-object cleanup                | pass   |

The successful source-backed sandbox exited `0` in `224.07 ms`. A
TERM-resistant sandbox was cancelled and removed in `1209.65 ms`; its attached
nerdctl process exited `1`. No owned container or published source tree
remained.

## Evidence handling

The workflow uploaded `guarded-oci-backend-evidence` successfully. The
downloaded machine-readable result is committed unchanged at
`services/runner-local/evidence/native/30605900587.json`.

This evidence admits the verified artifact read boundary, bounded source
materializer, opaque source capability, and guarded OCI bind. It does not
claim durable snapshot resolution, image/runtime admission, lifecycle event
spooling, runner transport, or autonomous research execution.
