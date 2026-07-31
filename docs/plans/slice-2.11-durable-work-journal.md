# Slice 2.11 durable work journal plan

Status: Complete

Date: 2026-07-31

Architecture: ADR-031, ADR-035, ADR-046, ADR-047, ADR-048

## Outcome

Durably bind one injected task delivery to one generated claim attempt before
the first network request, then reconcile the exact claim until a validated
`RunnerExecutionV1` snapshot is durably committed. The slice prevents runner
restart from inventing a new attempt after an ambiguous claim outcome.

## Boundary

Add two execution-plane modules:

1. a private file-backed work journal that admits, loads, lists, inspects, and
   commits exact task claims;
2. an `ExactClaimReconciler` that combines one journal item with the existing
   single-attempt HTTP client.

The input delivery contract is:

```ts
type RunnerTaskDeliveryV1 = {
  version: "1";
  deliveryId: UUID;
  taskId: UUID;
};
```

Delivery discovery and acknowledgement remain injected. The slice does not add
an outbox dispatcher, capability-routing query, broker, queue poller, API
status route, timers, backoff, heartbeat loop, cancellation controller, OCI
execution, or journal garbage collection.

## Shared durability refactor

Before journal implementation, extract only the execution-neutral primitives
already proven by the spool:

- validated private root/directory/file creation;
- same-directory exclusive temporary files;
- file sync and directory sync;
- immutable create-if-absent hard-link publication;
- atomic mutable replacement where the spool still needs it;
- owner, mode, regular-file, symlink, and hard-link-count checks;
- bounded recursive byte accounting and generated temporary cleanup.

Spool codecs, path layout, fault-point names, segment commits,
acknowledgements, and recovery policy stay spool-owned. Existing spool tests and
native evidence must pass unchanged after extraction before journal behavior is
added.

## Durable layout

All names are generated beneath a dedicated configured root:

```text
root/
  work/
    <sha256-delivery-id>/
      manifest.json
      claim.json
```

The immutable manifest contains format version, delivery ID, task ID, attempt
ID, admitted-at timestamp, and a checksum over its canonical core. The optional
immutable claim contains format version, delivery key, canonical execution
digest, complete `RunnerExecutionV1`, committed-at timestamp, and its own
checksum.

Protocol IDs never become path fragments. Directories are `0700`, files are
`0600`, and Linux native validation checks owner and single-link final records.

## Admission protocol

1. Validate the delivery contract and journal limits.
2. Serialize the root operation within the owning process.
3. Hash the delivery ID into its directory key.
4. If a manifest exists, validate every byte and return its attempt ID only
   when the delivery/task identity agrees.
5. Otherwise allocate one injected UUID and timestamp.
6. Canonicalize and checksum the complete manifest.
7. Enforce item, record, and root byte limits before publication.
8. Publish with write, file sync, exclusive hard link, temporary unlink, and
   directory sync.
9. Return only after the manifest entry is durable.

A crash exposes no manifest or the complete manifest. Duplicate calls cannot
allocate a second visible attempt. One process owns a root; multi-process
ownership requires a later OS-lock or transactional adapter.

## Claim reconciliation protocol

1. Load and validate the manifest and optional claim record.
2. If claimed, return the stored execution without calling the transport.
3. If pending, call `claimTask(taskId, { version: "1", attemptId,
leaseDurationMs })` exactly once.
4. Validate response task ID and attempt ID against the manifest and validate
   the complete execution contract.
5. Canonicalize, checksum, capacity-check, and immutably publish `claim.json`.
6. Reload the record and return only the durable execution snapshot.

Timeout, abort, connection ambiguity, authentication failure, conflict,
protocol failure, or capacity failure leaves the manifest pending and does not
write a claim. Concurrent reconcile calls are serialized. A conflicting
existing claim is corruption, never last-writer-wins.

## State and diagnostics

```text
delivery -> pending_claim -> claimed
```

There is no inferred rejected/expired terminal state in this slice. Diagnostic
state contains delivery ID, task ID, attempt ID, state, admitted timestamp, and
optional claimed timestamp. It excludes paths, credentials, URLs, HTTP bodies,
task payloads, and filesystem metadata.

## Capacity and ownership

- positive configuration limits maximum manifest bytes, claim bytes, work
  items, and total journal bytes;
- actual durable and temporary bytes are counted; manifest counters are not
  trusted;
- one runner process owns one journal root;
- all operations serialize at the root because item-count and root-byte limits
  are global;
- unresolved items are never deleted by age or capacity pressure.

## Adversarial matrix

- crash before/after temporary write, file sync, link, unlink, and directory
  sync for both records;
- duplicate delivery replay, delivery ID reused for another task, UUID/clock
  failure, and concurrent admissions;
- malformed, truncated, noncanonical, checksum-invalid, version-invalid, and
  identity-invalid records;
- symlink, directory substitution, permission drift, owner drift, hard-link
  injection, unknown file, and temporary debris;
- item, record, and root byte boundaries;
- network failure before request, ambiguous response loss, timeout, abort,
  unauthorized, conflict, malformed success, and wrong execution identity;
- crash after claim response but before any publication boundary;
- restart before claim, during claim commit, and after durable claim;
- concurrent reconciliation calls proving one transport call and one immutable
  result;
- spool durability regression and native Linux permission gates after shared
  primitive extraction;
- mutation attempts against returned delivery, diagnostics, and execution
  values.

## Delivery order

1. Add the strict delivery contract and journal record/error/state schemas.
2. Extract shared private-filesystem durability primitives without changing
   spool behavior.
3. Implement journal admission, load/list/inspect, capacity, and corruption
   handling.
4. Implement immutable claim commit and stored-execution recovery.
5. Add the exact single-call claim reconciler.
6. Add deterministic fault-injection and restart tests.
7. Extend native Linux validation for journal permissions, hard-link
   publication, and restart replay.
8. Run full local and CI gates before amending ADR-048 with immutable evidence.

## Exit criteria

1. A durable delivery always reuses the same attempt ID across restart.
2. Every injected admission crash exposes no record or one complete record.
3. Ambiguous claim failure leaves the item pending and makes no replacement
   identity.
4. A valid claim response is never returned before its complete execution
   snapshot is durable.
5. Restart after durable claim returns byte-identical execution without a
   network call.
6. Identity drift, corruption, links, permissions, concurrency, and capacity
   violations fail closed.
7. Shared durability extraction preserves all spool unit and native gates.
8. Discovery, source acknowledgement, timers, execution, and cleanup remain
   absent and injectable.
9. `LocalRunnerNotEnabledError` remains the production entry-point behavior.
10. Full repository and native Linux CI gates pass before the slice becomes
    Complete.

## Validation

Completed on 2026-07-31.

- implementation commit `06612fa` added the strict delivery contract, private
  journal, immutable manifest/claim codecs, exact claim reconciler, and native
  Linux evidence probe;
- runner-local passed 178 local tests, including 19 journal tests and twelve
  manifest/claim publication fault boundaries; all workspace formatting,
  typecheck, lint, tests, Phase 1/2 audits, production builds, and the
  low-severity dependency audit passed;
- GitHub Actions run `30648879704` passed the real PostgreSQL suites, API and
  runner integrations, native spool regression, native journal validation,
  Chromium product journey, and production builds;
- native artifacts `runner-work-journal-native-evidence` and
  `runner-spool-native-evidence` were uploaded by the successful run;
- delivery discovery, source acknowledgement, timers, retries, heartbeat
  coordination, OCI execution, garbage collection, and production runner
  enablement remain absent.
