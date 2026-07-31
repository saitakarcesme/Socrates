# Slice 2.5 guarded OCI adapter evidence

Status: Complete

Date: 2026-07-31

Architecture: ADR-042

## Native run

- GitHub Actions run: `30604679736`
- commit: `9c777abae3b1e68ae53102697fda414d502965c7`
- host class: GitHub-hosted Ubuntu 24.04 VM
- client: nerdctl `2.3.1`
- server: rootless containerd `v2.3.1`
- architecture: `amd64`
- cgroup: v2
- security options: AppArmor, builtin seccomp, private cgroup namespace,
  rootless
- image:
  `node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32`

The run used the same pinned provisioning and immutable image contract as the
ADR-041 reference workflow. Its focused mode skipped the already-completed
three-engine latency comparison but retained native-host, dependency,
rootless-engine, AppArmor, containerd, and pre-pull gates.

## Result

| Gate                              | Result |
| --------------------------------- | ------ |
| runner-scoped recovery before run | pass   |
| create before native inspection   | pass   |
| native OCI verification           | pass   |
| AppArmor exact label and deny     | pass   |
| non-identity UID map              | pass   |
| five zero live capability masks   | pass   |
| bounded execution                 | pass   |
| exact-fence cancellation          | pass   |
| final owned-object cleanup        | pass   |

The successful sandbox exited `0` in `238.05 ms`. A TERM-resistant sandbox was
cancelled and removed in `1223.42 ms`; its attached nerdctl process exited `1`.
No owned sandbox remained after recovery.

## Evidence handling

The workflow uploaded `guarded-oci-backend-evidence` successfully. The
downloaded machine-readable result is committed unchanged at
`services/runner-local/evidence/native/30604679736.json`.

This evidence admits the guarded low-level backend. It does not claim that
source materialization, image admission, the task-runtime ABI, event spooling,
runner transport, or autonomous research execution exists.
