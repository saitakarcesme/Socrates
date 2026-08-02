# Slice 2.50 inert attempt lifecycle composition

Status: Planned

Date: 2026-08-02

Architecture: ADR-080, ADR-082, ADR-084, ADR-085, ADR-086, ADR-087

## Outcome

Compose the complete admitted local attempt lifecycle behind one inert narrow
owner without introducing platform bootstrap, secrets, or runner activation.

## Input capabilities

`LocalRunnerAttemptLifecycle` receives:

- an unknown ADR-086 configuration candidate;
- a `RunnerControlPlaneClient & RunnerSourceSnapshotTransport` capability;
- a `LocalAttemptSandboxOwner` capability;
- an `ExecutionImageAdmissionPort` capability;
- one `LeaseAuthorityScheduler` used by attempt authority and dispatch delay;
- one `MonotonicTimeSource`;
- one `LocalAttemptDispatchObserver`;
- exact `WorkJournalIdentitySource` and `SpoolIdentitySource` capabilities;
- one `DirectorySync` capability shared by the two durable stores.

Configuration is parsed before any dependency property is read. External
capabilities are already authorized; their platform construction is not part
of this slice.

## Owned graph

The lifecycle privately creates and retains:

1. `LocalContentAddressedArtifactStore` at `roots.artifacts`;
2. `SourceSnapshotMaterializer` at `roots.sources` with exact identity and
   source limits;
3. `BoundedSourceArtifactResolverFactory` sharing the source archive bound;
4. `RuntimeRequestMaterializer` with exact identity/request bound;
5. `LocalAttemptOwner` with journal/spool roots, durability limits, execution
   policy, runtime limits, and lease/recovery timing;
6. `LocalAttemptDispatchLoop` with the same scheduler, observer, and poll
   interval.

Only `run(signal)` is public. Resources, paths, configuration, dependencies,
and owner/loop instances are not returned.

## Ordering and failures

1. Parse and detach configuration.
2. Capture/validate external capability methods.
3. Construct all inert local resources.
4. Publish the frozen lifecycle only after the complete graph succeeds.
5. On first `run`, delegate to the retained serial dispatch loop.

Invalid configuration becomes `invalid_configuration`; dependency getter or
method faults become `invalid_dependency`; unexpected constructor failure
becomes `composition_failed`. Public messages are fixed and causes retained.
No failed construction exposes or retries a partial graph.

## Adversarial matrix

- malformed configuration before every dependency getter/effect;
- missing, non-callable, proxy, and throwing dependency methods;
- dependency mutation after construction cannot redirect any operation;
- constructors perform no filesystem, network, process, timer, clock, UUID,
  recovery, image, sandbox, observer, or control-plane effect;
- exact single-authority mapping for identity, all roots, source/request/runtime
  bytes, execution policy, durability limits, lifecycle timing, and poll delay;
- no graph internals or configuration can be obtained from the lifecycle;
- invalid abort signal, pre-abort, cooperative stop, and private abort reason;
- concurrent/repeated `run` calls share one retained operation;
- real temporary artifact/source/journal/spool roots remain absent until run;
- real first idle run performs startup recovery before acquisition, observes
  idle once, delays once, and stops cooperatively;
- one real measured attempt traverses composed artifact/source/request,
  owner/session, durable publication, and cleanup boundaries;
- startup, dispatch, observation, and delay failure remain fail-stop with no
  second resource graph or retry.

## Delivery order

1. Commit ADR-087 and this plan before production code.
2. Align ADR-086 outer bounds with every already-admitted constructor so a
   parsed configuration cannot fail later during graph composition.
3. Add the lifecycle composition module and narrow error/result contract.
4. Map every consumed ADR-086 field once into admitted constructors.
5. Add adversarial construction and dependency-capture tests.
6. Add real durable idle and measured-attempt composition integrations.
7. Audit that platform resources, secrets, environment, process entry, and
   activation did not land.
8. Run every local and GitHub Actions gate before admitting ADR-087.

## Exit criteria

1. Invalid configuration precedes every dependency and external effect.
2. Construction is inert and publishes only a complete private graph.
3. Configuration and injected capabilities are the only authorities.
4. First run preserves startup recovery, serial ownership, observation, and
   cooperative stop semantics.
5. Internal resources and sensitive dependency objects are not exposed.
6. No credential/platform builder, environment loader, process entry point,
   shutdown owner, feature flag, or runner enablement lands.
