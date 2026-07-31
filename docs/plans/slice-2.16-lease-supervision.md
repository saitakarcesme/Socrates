# Slice 2.16 durable cancellation policy and lease supervision plan

Status: Planned

Date: 2026-07-31

Architecture: ADR-035, ADR-047, ADR-053

## Outcome

Persist the complete cancellation policy in the control plane, return it
atomically with an exact-fence heartbeat, and apply it through a one-step local
lease supervisor without adding a timer or execution loop.

## Boundary

Add schema compatibility 9, cancellation policy columns and checks, a strict
heartbeat response union, repository/API projection changes, and a pure
single-operation supervisor. Do not schedule heartbeats, execute work, emit
events, retry, back off, or enable the runner process.

## Control-plane state

Every cancellation row contains:

- request UUID and task UUID;
- resulting task status;
- database `requestedAt`;
- closed reason: `operator | budget | policy | runner_shutdown`;
- grace period from 0 through 60,000 ms.

The first row for a task wins. Duplicate cancellation requests return the
stored policy. Request ID reuse for another task remains a conflict. Existing
rows backfill to `operator` and 5,000 ms before `NOT NULL` is applied.

## Heartbeat contract

```text
continue -> { leaseExpiresAt, directive: continue }
cancel   -> { leaseExpiresAt, directive: cancel, cancellation policy }
stale    -> authenticated 409 conflict
```

The runner heartbeat request carries only exact fence identity and trusted
lease duration. It cannot supply or override cancellation policy.

## Supervisor outcomes

- `continue`: exact lease renewed; no cancellation call;
- `cancelled`: complete validated command applied once in this invocation;
- `stale`: authoritative conflict; caller has no lease authority;
- other transport/protocol failures: throw unchanged and perform no cancel.

## Adversarial matrix

- reason and grace lower/upper bounds plus invalid persisted shapes;
- migration ordering, backfill, checks, and compatibility-last rule;
- duplicate request replay preserves first policy;
- request ID collision across tasks;
- continue response rejects cancellation payload;
- cancel response requires the complete policy;
- runner cannot send policy in heartbeat request;
- exact runner/task/attempt/fence mapping into cancellation command;
- cancellation target called once and only for cancel;
- stale conflict, unauthorized, timeout, abort, malformed response;
- concurrent supervisor calls serialize;
- unchanged journal, spool, outbox ownership, and runner entry point;
- full authenticated PostgreSQL transport journey.

## Delivery order

1. Commit ADR-053 and this plan before production code.
2. Add migration, schema checks, ports, and repository policy persistence.
3. Tighten contracts, gateway, routes, and authenticated integration tests.
4. Add the one-step lease supervisor and adversarial unit tests.
5. Run all local and GitHub Actions gates before admitting ADR-053.

## Exit criteria

1. Every cancel directive carries complete immutable server policy.
2. Runner input cannot choose cancellation policy.
3. Duplicate requests cannot replace the first policy.
4. Supervisor cancellation identity exactly matches the frozen execution.
5. Continue and transient errors never invoke cancellation.
6. Stale authority is explicit and cannot masquerade as renewed.
7. No timer, loop, execution, event generation, or production enablement lands.
8. Schema migration and all repository, native, browser, build, and CI gates
   pass.
