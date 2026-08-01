# Slice 2.45 recovery-bound local attempt composition

Status: Planned

Date: 2026-08-01

Architecture: ADR-057, ADR-075, ADR-077, ADR-080, ADR-081, ADR-082

## Outcome

Add one effect-free local attempt owner that binds the exact startup-recovered
sandbox/source capabilities to a single deferred durable attempt graph. Keep
production startup, timers, polling, and `LocalRunner` enablement absent.

## Ownership boundary

`LocalAttemptOwner` accepts the raw narrow collaborators and immutable policy
needed for one local attempt graph. It does not accept a prebuilt startup
barrier, dispatcher, admission coordinator, durable store, sender, recovery
coordinator, or session factory.

The owner captures the exact sandbox and source capabilities once. It builds
the ADR-057 barrier from those captured facades and later gives the same
facades to the fresh/restart composition. This prevents recovery of one owner
followed by execution, release, or cancellation through another.

Construction must remain inert. Synchronous validation and method binding are
allowed; directory creation, store opening, cleanup, transport, process,
scheduler, admission, and session effects are not.

## Deferred durable graph

After startup recovery succeeds, composition performs this order exactly:

1. open one `LocalWorkJournal` at its validated resolved root;
2. open one `LocalEventSpool` at a distinct non-overlapping resolved root;
3. construct one sequential sender from that spool and control plane;
4. construct one completion coordinator from that journal and spool;
5. construct one terminal recovery coordinator from the same three owners;
6. construct one disposition auditor from the same journal and spool;
7. construct one work admission coordinator using that auditor/recovery pair;
8. expose only narrow fresh and restart session constructors to ADR-081.

Composition is retained by ADR-081. No partially opened graph is returned. If
either store fails to open, the dispatcher is permanently failed and later
calls perform no open, recovery, admission, or session effect. The owner does
not delete a root whose state may be uncertain.

Journal and spool roots may not be equal or contain one another after path
resolution. Existing private-filesystem link, ownership, canonical encoding,
and durability checks remain authoritative inside each store. Identity and
clock capabilities stay explicit and bounded.

## Session graph

Fresh sessions receive the exact shared journal, spool, recovery coordinator,
sandbox, source materializer, control plane, authority scheduler, monotonic
time source, artifact resolver, image admission port, request materializer,
runtime options, execution policy, and bounded timing/recovery values.

Restart sessions receive the exact shared disposition auditor, recovery
coordinator, sandbox, control plane, authority scheduler, and bounded timing/
recovery values. No path may allocate a second journal, spool, sender,
completion coordinator, recovery coordinator, disposition auditor, or
admission coordinator.

External collaborator methods are captured into narrow facades before any
effect. Mutating a source object's methods after owner construction cannot
redirect cleanup, acquisition, heartbeat, event submission, materialization,
execution, cancellation, or persistence.

## Configuration contract

Validate and deeply freeze before dispatch:

- journal/spool resolved roots and their strict non-overlap;
- journal/spool byte, item, segment, and identity-source limits;
- lease duration, heartbeat interval, revocation grace, and maximum recovery
  attempts;
- execution policy and runtime input/output/timeout limits;
- every required narrow dependency method.

Heartbeat interval must not exceed one third of lease duration. No default may
silently make a durability, authority, execution, or retry bound unbounded.
Startup cleanup counts remain diagnostic only.

## Failure matrix

- construction with malformed roots, overlapping roots, invalid limits,
  missing methods, mutation, getters, proxies, and throwing method binds;
- proof that construction creates no path, cleanup, network, process,
  scheduler, journal, spool, admission, or session effect;
- sandbox recovery before source recovery before journal open before spool
  open before admission;
- sandbox/source recovery failure and invalid cleanup counts open no store;
- journal failure prevents spool opening; spool failure exposes no graph;
- every first composition failure is replayed without another effect;
- idle and every non-session admission state allocate no session;
- fresh and restart paths use the exact recovered resource facades;
- sequential attempts reuse one journal/spool/coordinator graph;
- concurrent dispatch remains serialized through full session settlement;
- exact identity/routing results and deep immutability remain ADR-081-owned;
- real temporary journal/spool roots prove opening, recovery, publication,
  acknowledgement, completion, and restart reuse without duplicate owners.

## Delivery order

1. Commit ADR-082 and this plan before production code.
2. Add strict owner configuration and captured-facade contracts.
3. Implement deferred journal/spool opening and the shared coordinator graph.
4. Bind exact recovered owners into fresh and restart session factories.
5. Delegate explicit dispatch through ADR-057 and ADR-081 only.
6. Add adversarial mutation, ordering, failure, concurrency, and real-store
   composition tests.
7. Run every local and GitHub Actions gate before admitting ADR-082.

## Exit criteria

1. Construction has no external effect.
2. No durable store or attempt dependency can open before exact startup
   recovery succeeds.
3. The sandbox/source capabilities recovered are exactly those used by every
   attempt path.
4. One retained journal/spool/coordinator graph owns all explicit dispatches.
5. A partial or failed composition cannot retry or leak a callable graph.
6. All configuration is bounded, validated, immutable, and mutation-resistant.
7. No environment loader, process entry point, signal handler, timer, polling,
   backoff, automatic retry, concurrency scheduler, or runner enablement lands.
