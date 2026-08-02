# Slice 2.54 inert application-platform composition

Status: Planned

Date: 2026-08-02

Architecture: ADR-086, ADR-088, ADR-089, ADR-090, ADR-091

## Outcome

Join the admitted authenticated attempt lifecycle and OCI platform behind one
inert application-level owner, proving the complete resource graph without
introducing concrete system adapters, bootstrap, or runner activation.

## Inputs and admission order

`LocalRunnerApplicationPlatform` receives:

- one unknown ADR-086 non-secret configuration candidate;
- one unknown ADR-089 trusted-image catalog candidate;
- one unknown bearer-credential candidate;
- one explicitly injected fetch capability;
- one process executor and host-readiness inspector;
- one epoch clock and ephemeral probe-identity source;
- one lease scheduler and monotonic time source;
- one attempt-dispatch observer;
- one work-journal and one spool identity source; and
- one directory-sync capability shared by both durable stores.

Construction admits and detaches the non-secret configuration first, trusted
images second, and the credential third. No dependency owner or method is read
before all three candidates succeed. Fixed errors preserve this precedence:
`invalid_configuration`, `invalid_images`, `invalid_credential`,
`invalid_dependency`, then `composition_failed`.

## Owned graph

The platform privately constructs and retains:

1. one ADR-090 `LocalRunnerOciPlatform` from the admitted configuration,
   trusted images, process, host, epoch-clock, and probe-identity authorities;
2. one ADR-088 `LocalRunnerAuthenticatedAttemptLifecycle` from the same
   admitted configuration and credential plus captured lifecycle authorities;
3. the exact OCI platform object as both the lifecycle's sandbox owner and
   image-admission port; and
4. one bound lifecycle `run(signal)` operation.

There is one readiness verifier, OCI backend, image inspector, handshake
verifier, catalog, authenticated HTTP client, attempt owner, and dispatch loop.
The application platform exposes none of them and returns no configuration,
credential, dependency, path, or adapter state.

## Capability capture and authority

Every dependency method is read and bound once before either child graph is
constructed. The fetch function is bound without a global fallback. All child
constructors receive frozen captured ports, so owner or method mutation after
construction cannot redirect an operation. The application layer creates no
clock, identity, environment, filesystem, network, process, or timer default.

The OCI object must be passed by identity as both `sandbox` and `images`.
Startup recovery, image admission, runtime execution, and cancellation
therefore share one deployment/runner ownership boundary and one backend. The
authenticated lifecycle and OCI platform parse only the detached admitted
snapshots, never the original candidates.

## Lifecycle and failures

Construction is effect-free and freezes the opaque platform. `run(signal)`
delegates to the one retained authenticated lifecycle and preserves its
validation, pre-abort, single-run, cooperative shutdown, startup recovery,
serial dispatch, observation, delay, and fail-stop semantics.

Input and composition errors use fixed public messages and expose no `cause`.
Raw credential and untrusted candidate content must not appear in object keys,
JSON, inspection, messages, stacks asserted by public tests, or nested state.
After construction, operational errors are not retried, wrapped, or translated
by this layer.

## Adversarial matrix

- malformed configuration before image, credential, and every dependency;
- malformed trusted images before credential and every dependency;
- throwing or malformed credential before every dependency;
- missing, non-callable, proxy, accessor, and throwing dependency methods;
- caller mutation cannot replace any admitted snapshot, owner, or method;
- child construction receives detached snapshots rather than original inputs;
- the same OCI object is observed as sandbox and image authority;
- no second OCI backend, catalog, HTTP client, lifecycle, or fallback exists;
- construction performs no fetch, file, directory, process, host, clock,
  timer, UUID, recovery, image, observer, scheduler, or sandbox effect;
- platform and cause-free errors inspect and serialize without credential or
  untrusted data;
- invalid signal, pre-abort, concurrent/repeated run, and private abort reason;
- a real idle run performs exactly one OCI recovery before acquisition, then
  observes and delays cooperatively through the composed lifecycle;
- a measured fake execution traverses the shared image/sandbox authority; and
- recovery, transport, dispatch, observation, delay, and OCI failure remain
  fail-stop without constructing or invoking a second graph.

## Delivery order

1. Commit ADR-091 and this plan before production code.
2. Add the opaque application platform and fixed error contract.
3. Implement deterministic input admission and one-time capability capture.
4. Compose ADR-090 into ADR-088 as the exact sandbox/image authority.
5. Add adversarial ordering, capture, opacity, redaction, and aliasing tests.
6. Add real idle and measured cross-graph composition integrations.
7. Audit that no concrete adapter, loader, entry point, shutdown owner,
   feature flag, or activation landed.
8. Run every local and GitHub Actions gate before admitting ADR-091.

## Exit criteria

1. Configuration, images, and credential are admitted in deterministic order
   before any dependency access or external effect.
2. One captured authority exists for every external capability, with no
   ambient fallback or post-construction mutation path.
3. The exact OCI platform object owns both sandbox and image operations for
   the one authenticated lifecycle.
4. Construction is inert, opaque, frozen, redacted, and publishes only
   `run(signal)`.
5. Existing startup recovery, serial dispatch, cooperative stop, and fail-stop
   behavior survive the full composition boundary.
6. No concrete system adapter, loader, refresh, process entry, shutdown owner,
   feature flag, or runner activation lands.
