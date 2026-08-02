# Slice 2.58 descriptor-bound bounded file reader

Status: Proposed

Date: 2026-08-02

Architecture: ADR-094, ADR-095

## Outcome

Add one Linux-only Node primitive that reads a bounded regular file through a
single retained descriptor and returns one detached caller-owned byte snapshot.
The mutable `Uint8Array` is never retained by the reader and will be copied
again by ADR-094. It provides the final-component, inode, metadata, growth, and
mutation guarantees needed by a later deployment loader without selecting
deployment paths, composing three files, reading environment state, or
activating the local runner.

## Threat boundary

The reader protects against an untrusted final path component, symlink swap,
special file, hard-link alias, oversized or growing input, short read, metadata
drift, caller mutation, and raw error leakage. It does not claim that Node's
`O_NOFOLLOW` protects ancestor components. A later loader must admit canonical
paths beneath trusted, non-runner-writable, symlink-free ancestors before it
uses this primitive.

The deployment root authority is trusted. A privileged writer able to mutate
and restore one open inode between observable metadata snapshots remains
outside this primitive's threat model. Network filesystems, procfs/sysfs,
device files, pipes, sockets, and files with multiple hard links are rejected.

## Contract

`NodeBoundedRegularFileReader.read(input)` accepts one exact plain owner with:

- one canonical absolute POSIX `path`;
- one integer `maximumBytes` from one through the architecture-owned absolute
  ceiling of 16,777,216 bytes;
- one safe-integer `expectedOwnerUid` from zero through 4,294,967,294; and
- one exact read-only permission `mode` containing at least one of the `0o444`
  read bits and no write, execute, or higher bits.

It reads each owner property once in that order, detaches and freezes the
admitted request, and rejects control characters, NUL, comma, non-NFC text,
root, trailing slash, non-normalized paths, and paths beyond 4,096 UTF-8 bytes.
Construction is inert. `read` fails before filesystem access on Windows,
missing required open flags, or an invalid owner/mode policy. Production
deployment composition will require an unprivileged runner separately.

## Descriptor protocol

1. Open the exact final path once with
   `O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_NOCTTY`. Nonblocking and no-
   controlling-terminal flags are inert for regular files and prevent a FIFO
   or terminal device from blocking or acquiring process authority before
   descriptor metadata rejects it.
2. Obtain a bigint descriptor `stat` immediately.
3. Require one regular file, `nlink === 1`, the exact owner UID and mode, and a
   size from one through `maximumBytes`.
4. Read only through the retained handle in bounded chunks, permitting at most
   `maximumBytes + 1` observed bytes and explicitly reading through EOF.
5. Reject early EOF, a byte beyond the initial size, or any observed byte count
   different from the initial size.
6. Obtain a second bigint descriptor `stat` and require identical device,
   inode, kind, link count, UID, GID, mode, size, ctime nanoseconds, and mtime
   nanoseconds.
7. Close the retained handle exactly once before returning a detached
   `Uint8Array` copy.

No path-based stat or read occurs after open. Access time is deliberately
ignored because the read itself may update it. The reader never follows a
second path, retries, reopens, hashes, parses, decodes, logs, or retains the
descriptor or bytes.

## Failure contract

One frozen `NodeBoundedRegularFileReadError` exposes only a closed code:

- `invalid_input`;
- `unsupported_host`;
- `open_failed`;
- `invalid_metadata`;
- `size_limit`;
- `read_failed`;
- `content_changed`; or
- `close_failed`.

Messages are fixed. The path, bytes, owner input, raw syscall code, descriptor,
and underlying cause never escape through the error, JSON, inspection, or
stack assertions. Close failure after another failure must not replace the
primary failure or add a cause; a close failure after an otherwise successful
read becomes `close_failed`.

## Adversarial matrix

- null, array, proxy, inherited, extra-key, getter, throwing-getter, and
  post-call-mutated owners;
- relative, root, traversal, duplicate separator, dot-segment, trailing slash,
  comma, control-character, non-NFC, and overlong paths;
- zero, fractional, unsafe, negative, and overbroad numeric policies;
- Windows and absent-required-flag rejection before open;
- missing path, final symlink, directory, FIFO, socket, device where available,
  hard link, wrong UID, wrong GID policy where relevant, and wrong mode;
- empty, exact-limit, one-byte-over, sparse, growing, truncating, and replaced
  files;
- short reads, read errors, metadata mutation, inode stability, and explicit
  EOF proof;
- handle closure on every open success and cause-free fixed failures; and
- detached output that survives source rewrite and input mutation.

Linux-native cases are skipped locally on Windows and must pass on GitHub
Actions. Tests may use temporary files and the active non-root UID; they do not
inject a filesystem adapter into the production reader. A package-private core
may accept deterministic fake handles to prove short reads, metadata races, and
close precedence that cannot be induced portably; no such seam is exported by
the package or accepted by `NodeBoundedRegularFileReader`.

## Delivery order

1. Commit ADR-095 and this plan before production code.
2. Add the closed reader request, result, and error contracts.
3. Implement strict inert admission and Linux/flag gating.
4. Implement the one-open, two-stat, bounded-read, explicit-EOF protocol.
5. Add cross-platform admission tests and Linux-native adversarial tests.
6. Prove that no deployment path, environment lookup, systemd integration,
   parser composition, bootstrap, process entry, or activation landed.
7. Run every local and GitHub Actions gate before admitting ADR-095.

## Exit criteria

1. An accepted read uses one descriptor, never a path-based read after open,
   and returns only detached bytes after close.
2. Final symlinks, non-regular or linked files, metadata drift, short/growing
   content, and all configured size or ownership violations fail closed.
3. Every public error is fixed, frozen, cause-free, and contains no path or
   content.
4. Windows-local and Linux-native evidence together cover the full protocol.
5. Deployment path authority, three-file loading, credentials, environment,
   bootstrap, process entry, and runner activation remain absent.
