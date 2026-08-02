# Slice 2.59 descriptor-anchored public deployment admission

Status: Planned

Date: 2026-08-02

Architecture: ADR-094, ADR-095, ADR-096

## Outcome

Add one inert Linux-only production loader that reads the fixed non-secret
local-runner configuration and trusted-image catalog through a retained
descriptor chain rooted at `/`, admits each document at the earliest safe
point, and returns only frozen semantic values. Credential discovery, bootstrap,
activation, and runner execution remain absent.

## Fixed host layout

```text
/                                  root:0 0755
└── etc/                           root:0 0755
    └── socrates/                  root:0 0755
        └── runner-local/          root:0 0755
            ├── configuration.v1.json  root:0 0444, nlink 1
            └── trusted-images.v1.json root:0 0444, nlink 1
```

UID 0 is exact; GID is not policy because neither accepted directory nor file
grants group write authority. These documents contain only the closed
non-secret ADR-086 and ADR-089 schemas. Provisioning owns the tree and atomic
replacement. The runner is read-only and fail-closed.

## Descriptor protocol

1. Reject non-Linux hosts or absent required flags before filesystem access.
2. Require `/proc/self/fd` to report Linux `PROC_SUPER_MAGIC`.
3. Open `/` once and prove a UID-0, exact-`0755` real directory.
4. Retain that handle and open fixed child `etc` through
   `/proc/self/fd/<parent-fd>/etc` with
   `O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK | O_NOCTTY`.
5. Repeat the retained descriptor-relative step for `socrates` and
   `runner-local`, proving the same directory policy after every open.
6. Keep all four directory descriptors open while both final files settle.
7. Read each final file through ADR-095 using an internally constructed path
   beneath the retained `runner-local` descriptor.
8. Close every retained directory exactly once in reverse order. Preserve a
   primary failure over any cleanup failure.

The proc magic link is an intentional reference to an internally opened and
retained descriptor, not input-controlled traversal. The fixed child remains
the final component of a separate `O_NOFOLLOW` open. A future supported Node
`openat2` binding may replace this mechanism; no unstable internal binding or
non-TypeScript native addon is introduced now.

## Admission order

1. Read `configuration.v1.json` with the exact 1,048,576-byte ceiling and
   UID-0/mode-0444 policy.
2. Immediately admit fatal UTF-8, JSON, ADR-086 semantics, and exact canonical
   bytes. Failure prevents the trusted-image file from being opened.
3. Read `trusted-images.v1.json` with the exact 16,777,216-byte ceiling and
   the same ownership/mode policy.
4. Immediately admit fatal UTF-8, JSON, ADR-089 semantics, and exact canonical
   bytes.
5. Return a frozen owner containing only the existing detached frozen semantic
   snapshots.

Refactor ADR-094 internals so the staged public loader and existing three-input
`parseLocalRunnerDeploymentBytes` share one implementation. Preserve the
existing public parser behavior, order, errors, and source compatibility.

## Failure contract

`LocalRunnerPublicDeploymentLoadError` is frozen, contains no cause, and exposes
only:

- `unsupported_host`;
- `invalid_host`;
- `open_failed`;
- `invalid_metadata`;
- `configuration_failed`;
- `trusted_images_failed`; or
- `close_failed`.

No error, inspection representation, assertion, or serialization may expose a
path, descriptor, owner, metadata value, input byte, decoded document, parser
detail, raw syscall code, or nested error.

## Adversarial matrix

- construction causes no procfs, file, environment, process, clock, network,
  timer, identity, or logging effect;
- unsupported host and missing required flags precede procfs inspection;
- absent, masked, or wrong-type procfs precedes deployment-root access;
- every directory opens exactly once through its retained parent and remains
  retained through file settlement;
- directory symlink, regular-file substitution, UID drift, and every non-0755
  mode fail before the next component;
- missing, symlink, directory, FIFO, hard link, wrong UID, wrong mode, empty,
  oversized, changing, or non-canonical public files fail closed;
- malformed configuration prevents any trusted-image open;
- configuration and image errors normalize without causes or content;
- successful output contains no byte view and remains deeply frozen;
- handles close once in reverse order on every partial and successful path;
- cleanup failure cannot replace a primary failure; and
- production construction exposes no root, filename, filesystem, parser, or
  handle override.

Deterministic package-private tests own fake directory handles and staged read
capabilities. Public tests prove strict surface and Windows ordering. CI
provisions a Linux-native mirror fixture for real symlink, mode, hard-link,
size, canonicality, and valid-tree evidence without making the production root
configurable.

## Delivery order

1. Commit ADR-096 and this plan before production code.
2. Extract shared staged ADR-094 public-document admission without changing the
   existing three-input behavior.
3. Implement the package-private descriptor-chain protocol and closed errors.
4. Bind the production loader to the fixed host layout and concrete Node APIs.
5. Add deterministic, cross-platform, and Linux-native adversarial tests.
6. Prove credential, environment, bootstrap, signals, activation, and process
   entry remain absent.
7. Run every local and GitHub Actions gate before admitting ADR-096.

## Exit criteria

1. Public deployment documents are never opened through an unretained ancestor
   path after the root descriptor is acquired.
2. Configuration is semantically and canonically admitted before the image
   file can be opened.
3. Every accepted directory/file has exact architecture-owned ownership and
   mode policy; every descriptor is closed exactly once.
4. The result exposes only existing frozen semantic configuration and image
   values, with fixed cause-free failures.
5. Real Linux and deterministic evidence cover traversal, ordering, cleanup,
   metadata, size, canonicality, and valid admission.
6. Credentials, environment, refresh, bootstrap, process entry, signals,
   activation, and runner enablement remain absent.
