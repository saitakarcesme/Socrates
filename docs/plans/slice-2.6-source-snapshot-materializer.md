# Slice 2.6 source snapshot materializer plan

Status: In progress

Date: 2026-07-31

Architecture: ADR-033, ADR-040, ADR-042, ADR-043

## Outcome

Turn verified source-snapshot bytes into one private, immutable,
attempt-scoped tree that the guarded OCI backend can mount read-only. No
protocol field, archive entry, or caller-provided string may become an
unreviewed host path.

This slice is infrastructure, not a working autoresearch loop. Snapshot upload
and durable resolution, image/runtime admission, declared command execution,
measurement framing, event spooling, and transport remain later work.

## Capability chain

The implementation has four distinct authorities:

1. `VerifiedArtifact` proves digest and size inside this process.
2. `ArtifactStore.read` streams bytes for that real capability without exposing
   storage paths.
3. `SourceSnapshotMaterializer.materialize` verifies and publishes a private
   tree for one exact attempt.
4. `MaterializedSourceSnapshot` allows the OCI boundary, and only that
   boundary, to resolve the single source bind.

Identity strings alone cannot skip a link in this chain. Capabilities are
frozen and backed by process-local weak collections so structurally similar
objects fail.

## Archive profile

The initial profile is `application/vnd.socrates.source-snapshot.v1+tar`:

- uncompressed USTAR/PAX-compatible tar;
- regular files and directories only;
- no symlinks, hard links, devices, FIFOs, sockets, sparse files, or unknown
  entry kinds;
- no absolute, drive-qualified, traversing, empty-component, backslash, NUL,
  control-character, or non-NFC paths;
- portable components only, including no Windows device names, forbidden
  punctuation, trailing dot/space, or case-fold collisions;
- no duplicate paths or file/directory ancestor conflicts;
- no setuid, setgid, or sticky permissions;
- owner and timestamps ignored; output is read-only with only the executable
  bit retained.

Trusted materializer policy bounds archive bytes, expanded bytes, file count,
per-file bytes, path bytes, component bytes, path depth, and parser metadata.
Every declared entry size is checked before writing, and every streamed entry
must end at exactly that size.

`tar-stream` is a parser only. It receives no extraction root and performs no
filesystem operations. Compressed input fails as an invalid archive rather
than being auto-detected.

## Filesystem publication

Production code belongs in `services/runner-local/src/source`:

- `capability.ts`: opaque capability issuance, validation, and internal path
  resolution;
- `path-policy.ts`: portable path canonicalization and collision checks;
- `materializer.ts`: streaming verification, guarded writes, atomic publish,
  idempotent release, and scoped recovery;
- `index.ts`: narrow public exports that omit path resolution.

The configured root is resolved once and created privately. Each invocation
uses a generated staging name unrelated to raw IDs. A root-private manifest
records the ownership tuple and digest. The final directory is published only
after all files close successfully and archive digest, archive size, expanded
size, and terminator validation pass.

Every file is opened exclusively with no-follow semantics. Before each write,
all parents are checked with `lstat` and must be directories inside the staging
root. Cleanup and recovery compare resolved parent paths, strict generated
names, and manifest identity before recursive removal.

## Artifact-store read boundary

`ArtifactStore.read` accepts a `VerifiedArtifact` and a trusted maximum byte
count. It validates the process-local capability before reading the private
digest-derived object. The returned async stream is single-consumption and
rehashes/counts the object as it is read. Mutation, truncation, replacement,
oversize data, or a digest mismatch raises a typed artifact-store error.

The method never accepts a path or digest on its own and never exposes the
store root. Local-store tests cover forged capabilities and object mutation
between verification and reading.

## OCI integration

`SandboxExecution` may contain one `MaterializedSourceSnapshot`. Its ownership
must exactly match the sandbox deployment, runner, task, attempt, and fence.
The typed argument builder resolves it internally and emits only:

```text
--mount
type=bind,src=<private capability path>,dst=/socrates/source,rro,\
bind-propagation=rprivate
```

Native OCI inspection must find exactly that source and destination with
recursive read-only bind and private propagation semantics. Nerdctl does not
document `noexec`, `nosuid`, or `nodev` as supported bind keys; links, devices,
and set-ID content are therefore eliminated before mounting rather than
represented and weakened by an unsupported CLI option. All other non-runtime
metadata binds still fail. Backend tests prove that forged, released,
cross-attempt, and mismatched-digest capabilities never reach process
execution.

## Test matrix

Unit and integration tests cover:

- verified read, forged capability, mutation, truncation, oversize, and
  single-consumption;
- valid nested files, empty files/directories, executable-bit retention, and
  deterministic accounting;
- traversal, absolute and drive paths, backslashes, Unicode normalization,
  controls, reserved names, component/path/depth limits, duplicate and
  case-fold collisions;
- every link/device/FIFO/sparse/unknown type and unsafe mode;
- per-file, expanded, archive, entry-count, and malformed/truncated tar limits;
- parent conflicts and no-follow publication;
- failure cleanup, idempotent release, exact-owner recovery, and refusal to
  delete foreign or malformed directories;
- typed mount argv, ownership matching, forged/released capability rejection,
  and native-spec bind verification;
- one native reference-host run proving the source is readable, read-only, and
  absent after cleanup.

Property tests generate path components and archive entry sequences around the
security invariants. Ordinary tests require no OCI engine; the native proof
remains an explicit CI job.

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

Slice 2.6 is complete only when:

1. stored bytes can be read only through a genuine verified capability;
2. archive digest and size are checked again during materialization;
3. adversarial entries cannot escape or weaken the private tree;
4. success exposes no host path outside the local execution package;
5. OCI creation and native inspection agree on the exact read-only source bind;
6. cleanup and recovery cannot target a foreign attempt or directory;
7. unit, property, full workspace, dependency, and native evidence gates pass;
8. architecture and immutable evidence identify the admitted implementation.
