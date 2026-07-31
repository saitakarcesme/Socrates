# Slice 2.9 durable local event spool plan

Status: Complete

Date: 2026-07-31

Architecture: ADR-037, ADR-039, ADR-040, ADR-045, ADR-046

## Outcome

Persist a closed lifecycle-draft batch as complete `RunnerEventV2` envelopes
before any delivery attempt, then recover the exact unacknowledged envelopes
after process restart. The slice proves local durability and replay semantics;
it does not communicate with the control plane or enable production execution.

## Research basis

- Karpathy autoresearch makes the experiment record the continuity mechanism;
  Socrates keeps that lesson but replaces mutable `results.tsv` state with
  validated, attempt-fenced events.
- Current autoresearch runners such as SPDL expose explicit checkpoint/resume
  state, reinforcing that process memory cannot be the recovery boundary.
- Node's filesystem API provides explicit file synchronization and atomic
  rename primitives, while warning that concurrent promise-based mutations are
  not synchronized. The spool therefore serializes each attempt and admits one
  owning process per configured root.

Primary references:

- <https://github.com/karpathy/autoresearch>
- <https://facebookresearch.github.io/spdl/main/autoresearch/autoresearch.html>
- <https://nodejs.org/api/fs.html>

## Boundary

Add a `spool` module to `services/runner-local`. Public operations are:

1. open or create an attempt bound to one validated `RunnerExecutionV1`;
2. atomically append one non-empty immutable draft batch;
3. iterate immutable pending envelopes in sequence order;
4. durably accept one exact `RunnerEventAcknowledgement` at a time;
5. inspect bounded state for diagnostics without exposing host paths.

The module may depend on contracts, the lifecycle draft type, canonical JSON,
cryptographic hashes, UUID generation, an injected clock, and a private
filesystem adapter. It cannot depend on the API, database, transport, OCI
engine, source materializer, or wall-clock globals hidden inside domain logic.

Add `RunnerEventAcknowledgementV1` to `@socrates/contracts` with a strict
versioned JSON schema. It carries `eventId`, `attemptId`, acknowledged and
expected sequences, and an RFC 3339 `receivedAt` string. This prevents the
runner from importing the database port's internal `Date` representation.

The append operation accepts one complete lifecycle result per attempt. The
batch contains exactly one terminal draft in final position, and no later
segment is permitted. Incremental producers are deferred until they have an
independent idempotency-key contract.

## Durable layout

All names below are internally generated beneath a trusted private root:

```text
root/
  attempts/
    <sha256-attempt-key>/
      manifest.json
      commit.json
      acknowledgement.json
      segments/
        0000000000000001-0000000000000007.json
```

- The attempt key hashes runner ID, task ID, attempt ID, and fence.
- The immutable manifest stores a format version, those identities, and the
  SHA-256 digest of canonical `RunnerExecutionV1` bytes.
- Each segment stores a format version, attempt key, inclusive range, complete
  validated events, and a checksum over canonical segment contents.
- The immutable commit marker binds the segment filename, checksum, range, and
  terminal event ID. A successful append requires both segment and marker.
- The acknowledgement stores the exact control-plane acknowledgement and its
  corresponding durable event identity, plus a locally derived terminal
  tombstone that is not part of the wire contract.
- Filenames are fixed-width and lexically sortable. Protocol strings never
  become path fragments.

## Commit protocol

1. Serialize all operations for the attempt.
2. Re-read and validate manifest, acknowledgement, segment names, checksums,
   strict contiguous ordering, envelopes, and terminal state.
3. Validate every draft and allocate its sequence and event ID in memory.
4. Use one injected timestamp for the atomically observed batch.
5. Validate every full V2 envelope and canonicalize the complete segment.
6. Enforce event-count, segment-byte, attempt-count, and root-byte limits.
7. Open an exclusive same-directory temporary file, write all bytes, sync it,
   close it, publish the immutable final name with an exclusive hard link,
   unlink the temporary name, and sync the directory.
8. Publish and sync the immutable commit marker with the same protocol.
9. Return only after both final directory entries are durable.

An existing final name must contain exactly the same bytes; otherwise the spool
is corrupt. A crash before link publication leaves no segment. A crash after
link publication leaves the whole segment. Internally named temporary files are
recoverable debris, not evidence.

Recovery publishes a missing marker when exactly one valid closed segment is
present. A marker without that segment is corruption unless its terminal event
is the exact durable acknowledgement, proving authorized post-ack cleanup.

## Acknowledgement protocol

- The acknowledgement must reference the first pending event.
- Event ID, attempt ID, acknowledged sequence, and expected next sequence must
  match the persisted event and control-plane contract exactly.
- `receivedAt` must be a valid timestamp and becomes immutable local evidence.
- The record advances by atomic replacement with file and directory sync.
- A duplicate of the current durable acknowledgement is a no-op only when all
  fields match.
- Regressions, gaps, foreign attempts, conflicting IDs, or impossible expected
  cursors are corruption/protocol errors.
- Only after the acknowledgement is durable may a fully acknowledged segment
  be deleted and its directory synchronized.

## Capacity and ownership

- Configuration supplies positive maximum segment bytes, events per segment,
  attempt count, and total spool bytes.
- Existing durable and temporary bytes are counted at startup; limits do not
  trust manifest counters.
- Capacity failure preserves every existing record and returns a typed error.
- One process owns a spool root. An in-process keyed serializer prevents local
  races but is not represented as a distributed lock.
- Native Linux startup verifies the dedicated root, directory/file types,
  ownership expectations, private modes, and directory-sync support.

## Adversarial matrix

- crash/fault before and after every write, file sync, rename, directory sync,
  acknowledgement replacement, and segment cleanup;
- truncated JSON, trailing bytes, non-canonical JSON, checksum mismatch, and
  invalid V2 envelopes;
- missing, overlapping, duplicate, out-of-order, negative, or overflow ranges;
- altered execution snapshot under the same attempt identity;
- UUID, clock, sequence, event-count, segment-byte, root-byte, and attempt-count
  boundaries;
- concurrent append and acknowledgement calls within one process;
- symlink and unexpected-file injection at every generated directory level;
- acknowledgement replay, regression, jump, foreign attempt, wrong event ID,
  wrong expected cursor, and invalid receive timestamp;
- terminal segment followed by an append attempt;
- mutation of drafts, returned envelopes, and recovered values;
- restart with debris only, committed segment only, acknowledgement only, and
  acknowledged-but-not-yet-cleaned segment states.

## Delivery order

1. Define the shared wire acknowledgement plus strict manifest, segment,
   acknowledgement-state, diagnostic-state, and error contracts.
2. Implement canonical envelope allocation and checksummed segment codecs.
3. Implement the private-root filesystem adapter and durable replacement
   primitive.
4. Implement serialized open, append, pending, acknowledge, and cleanup flows.
5. Add deterministic restart and fault-injection tests.
6. Add native Linux durability, permissions, and recovery validation.
7. Run full repository gates and amend ADR-046 with immutable evidence.

## Exit criteria

1. A committed batch recovers byte-identically with the same IDs, sequences,
   timestamps, and payloads after restart.
2. Every injected crash exposes either no batch or the full valid batch.
3. Pending iteration is contiguous and begins after the durable cursor.
4. An accepted or replay acknowledgement cannot delete unacknowledged evidence.
5. Corruption, identity drift, concurrency, and capacity violations fail closed.
6. No protocol-facing attempt operation accepts or returns a host path; only
   trusted spool bootstrap accepts the dedicated root.
7. The spool imports no transport, database, engine, or control-plane module.
8. `LocalRunnerNotEnabledError` remains the production behavior.
9. Full workspace and native Linux durability gates pass.

## Validation

Completed on 2026-07-31.

- local formatting, typecheck, lint, unit/adversarial tests, Phase 1 and Phase 2
  dependency audits, production builds, and low-severity dependency audit
  passed with no known vulnerabilities;
- runner-local passed 150 unit/adversarial tests locally, with three
  database-gated tests skipped;
- GitHub Actions run `30644887440` passed all 153 runner-local tests against
  PostgreSQL, the full repository pipeline, and the browser journey;
- the native Ubuntu probe passed all ten durability, permission, restart,
  acknowledgement, cleanup, and corruption gates;
- immutable native evidence is stored at
  `services/runner-local/evidence/native/1785513485110-bbef45b2-ef4d-4bdd-a8cf-7358b8622bb4-spool.json`;
- production runner enablement and transport remain explicitly out of scope.
