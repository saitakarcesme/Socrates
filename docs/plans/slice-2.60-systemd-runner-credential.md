# Slice 2.60 systemd runner credential admission

Status: Admitted

Date: 2026-08-02

Architecture: ADR-094, ADR-095, ADR-097

## Outcome

Add one inert Linux-only loader that reads the local runner bearer token from
the exact systemd activation credential directory through retained descriptors
and returns only the already-admitted token. It does not compose, bootstrap, or
activate the runner.

## Fixed activation contract

```text
CREDENTIALS_DIRECTORY=/run/credentials/socrates-runner-local.service

/                                      root:0 0755
└── run/                                root:0 0755
    └── credentials/                    root:0 0755
        └── socrates-runner-local.service/ root or service UID 0500
            └── runner-bearer-token     same owner 0400, nlink 1, 85 bytes
```

The process effective UID must be non-root. The root-owned final-directory
variant relies on systemd's service-UID ACL; the service-owned variant is
systemd's documented read-only-filesystem ownership fallback. No other owner,
mode, path, filename, or byte length is accepted.

## Admission protocol

1. Reject non-Linux hosts or unavailable required open flags before reading the
   environment.
2. Read only `CREDENTIALS_DIRECTORY`, once, and require the exact fixed value.
3. Read the effective UID once and require a safe non-root Linux UID.
4. Require `/proc/self/fd` to report `PROC_SUPER_MAGIC`.
5. Open `/`, then fixed components `run`, `credentials`, and
   `socrates-runner-local.service` through retained parent descriptors.
6. Prove UID-0/exact-0755 on the first three directories and root-or-service-
   UID/exact-0500 on the unit directory.
7. Read fixed `runner-bearer-token` through ADR-095 with the unit-directory
   owner, exact mode 0400, and exact 85-byte ceiling.
8. Apply ADR-094 credential admission immediately and return only its immutable
   string result.
9. Close every directory handle exactly once in reverse order, preserving a
   primary failure over cleanup failures.

## Failure contract

`LocalRunnerSystemdCredentialLoadError` is frozen and exposes only:

- `unsupported_host`;
- `invalid_environment`;
- `invalid_identity`;
- `invalid_host`;
- `open_failed`;
- `invalid_metadata`;
- `credential_failed`; or
- `close_failed`.

No public failure, assertion, inspection representation, or serialization may
contain the environment value, path, UID, descriptor, metadata, bytes, token,
admission detail, syscall code, cause, or nested error.

## Adversarial matrix

- construction performs no environment, identity, procfs, filesystem, process,
  network, clock, timer, random, or logging effect;
- unsupported host precedes the sole environment read;
- missing or alternate environment precedes identity and procfs;
- root, missing, invalid, or throwing effective identity precedes procfs;
- procfs rejection precedes credential-tree access;
- every directory opens once through its retained parent and stays open until
  credential settlement;
- ancestor symlink/substitution, owner drift, or mode drift fails before the
  next component;
- both root-plus-ACL and service-owner unit-directory/file pairs are accepted;
- mismatched owner, symlink, directory, FIFO, hard link, wrong mode, empty,
  84-byte, 86-byte, changing, or malformed credential fails closed;
- credential bytes are detached, immediately admitted, and never returned;
- handles close once in reverse order on partial and successful paths;
- cleanup failure cannot replace a primary failure; and
- production exposes no environment, identity, root, filename, filesystem,
  parser, or handle override.

## Delivery order

1. Commit ADR-097 and this plan before production code.
2. Extract package-private ADR-094 credential-byte admission without changing
   the existing three-input parser.
3. Implement the package-private descriptor-chain protocol and closed errors.
4. Bind the production loader to the fixed systemd environment and Node APIs.
5. Add deterministic, public-surface, and Linux-native adversarial tests.
6. Add exact CI fixture provisioning, focused mutations, and exact cleanup.
7. Prove public deployment, bootstrap, signals, activation, and process entry
   remain absent.
8. Run every local and GitHub Actions gate before admitting ADR-097.

## Exit criteria

1. The token is never accepted from an ordinary value-bearing environment
   variable or caller-selected path.
2. Every filesystem component is bound to one retained descriptor and exact
   systemd-compatible metadata policy.
3. Only an exact 85-byte, schema-valid token reaches the immutable result.
4. Every failure is cause-free and redacts the path, environment, identity,
   metadata, and credential.
5. Deterministic and real Linux evidence cover ordering, traversal, owner
   models, metadata, size, admission, and cleanup.
6. Bootstrap, process entry, signals, activation, and runner enablement remain
   absent.

## Admission evidence

Architecture commit `3a772ec` preceded implementation commit `67be84d`.
Implementation adds credential-only reuse of ADR-094, one closed public error
contract, a deterministic descriptor-chain core, the concrete no-override Node
loader, public exports, a canonical test token, and exact Linux CI provisioning,
mutation, restoration, and cleanup.

Thirty-two deterministic core tests cover strict environment, identity, procfs,
directory, file-request, admission, cleanup, and redaction behavior. They admit
both systemd owner models and reject alternate environment values, root or
malformed identity, unavailable procfs, partial opens, invalid descriptors,
wrong public/unit directory metadata, credential read/admission failures, and
cleanup failures. Four production-surface tests cover inert construction,
zero-argument authority, unsupported hosts, the real fixed tree, and closed
adversarial failures. The preserved sixteen ADR-094 byte tests and fifty-two
ADR-095 descriptor-reader tests continue to prove exact 85-byte token admission
and final-file kind, link, owner, mode, size, content, and race constraints.

All 1,388 locally runnable runner-local tests passed; twelve Linux/database-
dependent cases were deferred. Formatting, all 14-package type and lint gates,
both architecture audits, the database-free workspace suite, production build,
and local web/API HTTP 200 health checks passed.

Main CI run `30739476744` passed all 1,396 applicable runner-local tests across
69 files with four intentionally inapplicable branches skipped. The normal run
admitted a service-owned `0500` unit directory and same-owner `0400` exact-byte
credential beneath the fixed `CREDENTIALS_DIRECTORY`. Twelve focused runs then
proved alternate environment, missing file, final symlink, hard link, wrong
mode, mismatched owner, directory substitution, 84-byte, 86-byte, malformed
85-byte, writable unit-directory, and unit-symlink cases fail with the expected
closed code. Exact restoration and cleanup passed. The same run passed
PostgreSQL migrations and seeds, database and API integrations, the existing
public-deployment adversarial matrix, native spool and journal durability, the
isolated Chromium journey, production build, and both native evidence uploads.
Systemd unit provisioning, deployment composition, bootstrap, process entry,
signals, activation, and runner enablement remain absent.
