# Slice 2.12 fenced task offers plan

Status: Planned

Date: 2026-07-31

Architecture: ADR-031, ADR-035, ADR-047, ADR-048, ADR-049

## Outcome

Deliver one compatible queued task to one authenticated runner through a
durable control-plane reservation, admit it to the local work journal, and
claim it only through the exact delivery/task/attempt identity. The slice
closes discovery races without enabling task execution.

## Boundary

Add four components:

1. a `runner_task_deliveries` persistence projection and migration;
2. scheduler repository operations to acquire and delivery-scope a claim;
3. authenticated acquire and delivery-claim HTTP contracts/routes;
4. a single-attempt `HttpTaskSource` plus journal admission adapter.

Do not add an outbox dispatcher, broker, long polling, timer, backoff,
reservation expiry, reassignment, batch acquisition, heartbeat loop,
cancellation loop, OCI execution, garbage collection, or production process.

## Delivery state

```text
queued task -> offered delivery -> claimed delivery + leased task
```

The delivery row contains delivery ID, workspace ID, task ID, runner ID,
state, optional attempt ID/fence, offered timestamp, and optional claimed
timestamp. The task and delivery must remain workspace-consistent. Claimed
identity is immutable. There is no expired/revoked state in this slice.

## Acquire transaction

1. Derive runner identity from the authenticated credential.
2. Lock and validate the active runner registration.
3. Return the runner's existing unresolved offered delivery first.
4. Check active attempt count against registered capacity.
5. Select a bounded deterministic window of queued protocol-2 tasks in the
   runner workspace without an active delivery, using row locks and
   `SKIP LOCKED`.
6. Apply the existing exact capability predicate.
7. Insert one delivery UUID for the first compatible candidate.
8. Return only `{ version, deliveryId, taskId }` after commit.

Concurrent transactions must yield at most one active delivery for a task.
No-compatible-work returns a closed `none` result and HTTP 204.

## Delivery claim transaction

1. Validate delivery/task/attempt/lease-duration contracts.
2. Lock the authenticated runner registration and delivery row.
3. Reject foreign, missing, conflicting, or non-offered deliveries without
   revealing cross-workspace existence.
4. Invoke the existing claim state machine in the same transaction with the
   delivery task and journal attempt UUID.
5. On success, store attempt ID, fence, state `claimed`, and claimed timestamp.
6. On exact replay, return the same execution snapshot.
7. On any scheduler conflict, roll back delivery mutation.

The existing raw task claim primitive remains for Slice 2.10 compatibility,
but the new task source never calls it.

## HTTP contracts

- `POST /v1/runner/task-deliveries/acquire`
  - request `{ version: "1" }`;
  - response 200 `{ version: "1", delivery }` or 204 empty;
- `POST /v1/runner/task-deliveries/:deliveryId/claims`
  - request `{ version: "1", taskId, attemptId, leaseDurationMs }`;
  - response reuses the strict execution envelope.

Bodies, responses, and errors remain bounded. Redirects are rejected by the
client. Each client call performs one network attempt and has no hidden retry.

## Local source protocol

`HttpTaskSource.acquire()` returns one delivery or `null`. A
`JournaledTaskSource.acquire()` immediately passes a non-null delivery to
`LocalWorkJournal.admit` and returns its immutable diagnostic state only after
manifest durability. `ExactClaimReconciler` uses the delivery-scoped claim
method. Ambiguous acquire is retried by the caller later; server replay returns
the same offer. Ambiguous claim preserves the journal attempt as in Slice 2.11.

## Adversarial matrix

- two runners and many concurrent acquire transactions for one task;
- one runner concurrently acquiring twice;
- existing-offer replay across API and runner restart;
- runner inactive, at capacity, foreign workspace, protocol mismatch, and
  exact capability mismatch;
- malformed capability JSON and deterministic bounded candidate ordering;
- delivery/task/runner/attempt conflicts and claimed replay;
- crash before/after delivery insert commit and claim transaction commit;
- HTTP timeout, abort, response loss, malformed/oversized JSON, 204 body drift,
  redirects, and authentication failure;
- journal admission fault after acquire proving server offer replay;
- raw outbox rows remain unchanged throughout acquire/claim;
- query-plan evidence for the unresolved-offer and queued-candidate paths;
- returned delivery/state/execution mutation attempts.

## Delivery order

1. Add strict acquire and delivery-claim contracts.
2. Add ADR-approved migration, compatibility version, constraints, and indexes.
3. Implement repository acquire and delivery-scoped claim transactions.
4. Add application service and authenticated routes.
5. Extend the one-attempt HTTP client and exact claim reconciler.
6. Add the journaled task-source adapter.
7. Add unit, concurrency, real PostgreSQL, API, restart, and transport tests.
8. Run full local and CI gates before amending ADR-049 with immutable evidence.

## Exit criteria

1. One task has at most one active offer and one authenticated owner.
2. The same runner re-acquires the same unresolved delivery across restart.
3. No runner can choose a task, workspace, owner, cursor, or batch size.
4. Delivery-scoped claim requires the exact durable attempt identity.
5. Delivery `claimed` and scheduler lease commit or roll back together.
6. Concurrent consumers cannot produce two visible delivery identities.
7. Capability and tenant matching stay exact and default-deny.
8. Outbox publication state is never read or mutated as runner acknowledgement.
9. Network ambiguity preserves server delivery and local attempt identity.
10. Discovery timers, reassignment, execution, and cleanup remain absent.
11. `LocalRunnerNotEnabledError` remains the production entry-point behavior.
12. Full repository, PostgreSQL, browser, build, and CI gates pass before the
    slice becomes Complete.
