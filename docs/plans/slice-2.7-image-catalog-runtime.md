# Slice 2.7 admitted image catalog and task-runtime ABI plan

Status: In progress

Date: 2026-07-31

Architecture: ADR-033, ADR-042, ADR-043, ADR-044

## Outcome

Replace the temporary test-only image issuer with a trusted image catalog and a
versioned in-image runtime. A task digest can select only an operator-admitted,
already-present Linux image whose platform, immutable OCI configuration, fixed
entrypoint, and live handshake match one catalog record.

The slice also defines the binary-safe request/response boundary used inside
the sandbox. It does not yet translate runtime frames into durable runner
events or enable the `Runner` interface.

## Trusted catalog

Each closed catalog entry pins:

- a canonical repository plus platform-specific `sha256` reference;
- Linux architecture (`amd64` or `arm64`);
- OCI manifest digest and configuration digest;
- `socrates.task-runtime.v1`;
- the absolute runtime executable and fixed bootstrap arguments;
- a runtime build identity digest;
- exact permitted image environment defaults;
- the existing fixed sandbox profile probe.

Catalog construction validates duplicate digests, references, platforms,
entrypoints, environment names, and ABI/build identities. Task lookup uses only
digest plus requested platform. Tags and caller-provided references are not
inputs.

The initial catalog is trusted local runner configuration. Dynamic registry
discovery, registry pulls, image building, and image signature policy are
separate deployment concerns.

## OCI inspection

`services/runner-local/src/image` contains:

- `catalog.ts`: trusted declarations, lookup, admission cache, and opaque
  capability issuance;
- `inspection.ts`: strict nerdctl image/manifest inspection parsers;
- `capability.ts`: process-local image capability and internal resolution;
- `index.ts`: public catalog types without an unsafe issuer.

Admission performs bounded no-shell process calls through the existing OCI
process port. It never pulls. Docker-compatible inspection establishes the
resolved local reference; native inspection establishes the OCI manifest,
configuration, platform, entrypoint, environment, volumes, and layer/config
digests. Unknown or missing fields fail closed.

The image is then created under the guarded profile with the fixed
`--handshake` runtime operation. One valid frame must match the catalog ABI and
build identity. Handshake output is confirmation only; it cannot create a
catalog entry.

## Runtime request

The container is created with stdin open, no terminal, and the fixed catalog
entrypoint. The outer process boundary writes exactly one request:

```text
uint32be payload length
strict UTF-8 JSON payload
EOF
```

The maximum request is fixed and checked before create. The canonical request
contains:

- schema `socrates.task-runtime.request.v1`;
- exact runner/task/attempt/fence identity;
- source digest and fixed `/socrates/source` location;
- ordered action commands;
- one measurement command and result byte limit;
- command, wall-time, writable, and output budgets already capped by runner
  policy.

Unknown fields, non-canonical JSON, invalid UTF-8, extra frames, trailing bytes,
or early EOF fail before source copying or command execution.

## Runtime execution

Production runtime code belongs in a new TypeScript workspace package under
`services/task-runtime`. It has no control-plane, database, model-provider,
network, or container-engine dependencies.

The runtime:

1. validates the request and ABI;
2. verifies the fixed source and workspace locations;
3. copies the read-only source tree without following links;
4. keeps `/workspace` no-exec in ABI v1;
5. executes each image-baked absolute tool with `shell: false`;
6. restricts cwd to `/workspace`;
7. supplies only the fixed environment declared by the ABI;
8. applies per-command timers and stops after the first failed action;
9. runs the measurement only after all actions succeed;
10. emits one terminal frame and exits consistently with it.

The runtime never interprets a shell string, reads host environment secrets,
opens a network control channel, or writes outside `/workspace` and `/tmp`.
Outer cgroups, AppArmor, seccomp, wall timeout, cancellation, and cleanup remain
authoritative.

The production entrypoint is one deterministic bundle. A two-pass build hashes
the placeholder-bearing bundle, embeds that digest into the final bundle, and
emits a matching build manifest for image assembly. Runtime argv and environment
cannot select or replace the handshake build identity.

## Runtime output

Every frame is:

```text
uint32be frame length
strict UTF-8 JSON frame
```

The closed frame union contains:

- `runtime.handshake`;
- `command.started`;
- `command.output` with `stdout` or `stderr`, monotonic sequence, and base64
  bytes;
- `command.exited`;
- `measurement.result` with bounded base64 bytes, an independent zero-based
  sequence, and an explicit final marker;
- `runtime.error`;
- `runtime.completed`.

Child bytes are never copied directly to runtime stdout or stderr. Frame count,
individual length, aggregate length, stream sequence, command order, and
terminality are bounded and verified independently by the outer decoder.
Runtime stderr must remain empty.

## Delivery order

1. Add request/frame contracts and property tests in an execution-neutral
   package.
2. Implement the runtime parser, source copy, exact spawn boundary, and framed
   encoder behind injected ports.
3. Add a deterministic runtime image recipe for native validation.
4. Implement strict local OCI image inspection and the catalog capability.
5. Replace the test-only image issuer in production paths.
6. Extend the guarded backend with bounded stdin and fixed runtime invocation.
7. Run adversarial unit tests and the native reference-host proof.

## Adversarial matrix

- forged catalog entries and capability lookalikes;
- tag, digest, platform, config, entrypoint, environment, volume, ABI, and
  build-identity mismatches;
- missing local image and attempted implicit pull;
- oversized, truncated, duplicate, non-canonical, invalid UTF-8, and
  trailing-byte requests;
- command order, cwd, argv, timeout, and environment mutations;
- binary output, frame injection text, invalid base64, oversized frames,
  write-fragment frame amplification, sequence gaps, duplicate terminal
  frames, and trailing output;
- source-copy traversal or links;
- action failure preventing measurement;
- cancellation, runtime crash, timeout, and cleanup;
- native handshake, one successful action/measurement, read-only source, and
  no residual sandbox.

Property tests cover frame fragmentation/coalescing, request framing, and
command/output sequences. Ordinary workspace tests require no OCI engine.

## Quality gates

```text
pnpm format:check
pnpm typecheck
pnpm lint
pnpm test
pnpm audit:phase-1
pnpm audit:phase-2
pnpm build
pnpm audit --audit-level=low
```

## Exit criteria

Slice 2.7 is complete only when:

1. a digest/platform pair absent from trusted catalog configuration cannot be
   inspected into authority;
2. local OCI content and live handshake match every pinned catalog field;
3. only a genuine process-local image capability reaches the OCI backend;
4. task commands are delivered to the fixed runtime over bounded stdin rather
   than engine argv or environment;
5. runtime child output cannot forge control frames;
6. source copying and command execution remain inside bounded sandbox paths;
7. unit, property, dependency, full workspace, and native gates pass;
8. immutable evidence and an ADR validation amendment admit the implementation.

## References

- OCI Image Manifest Specification:
  `https://github.com/opencontainers/image-spec/blob/main/manifest.md`
- OCI Image Configuration Specification:
  `https://specs.opencontainers.org/image-spec/config/`
- nerdctl command reference:
  `https://github.com/containerd/nerdctl/blob/main/docs/command-reference.md`
