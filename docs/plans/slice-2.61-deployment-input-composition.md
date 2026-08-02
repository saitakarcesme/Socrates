# Slice 2.61 deployment input composition

Status: Admitted

Date: 2026-08-02

Architecture: ADR-088, ADR-093, ADR-096, ADR-097, ADR-098

## Outcome

Add one inert production loader that serially joins the admitted public
deployment documents and systemd bearer credential into the existing frozen
`LocalRunnerDeploymentInputs` value. Platform composition, bootstrap, and
runner activation remain absent.

## Join protocol

1. Construct and invoke one fixed public-deployment loader.
2. Await complete configuration and trusted-image admission.
3. On any public failure, return one closed failure without constructing or
   invoking the credential loader.
4. Only after public success, construct and invoke one fixed systemd credential
   loader.
5. Await exact credential admission; never retry or fall back.
6. Read admitted public properties in `configuration`, then `trustedImages`
   order and return a new frozen owner with those values and the credential.
7. Retain no child loader, partial result, bytes, host authority, or error.

No child operation is concurrent. Each explicit call owns a fresh complete
snapshot and is not a refresh API.

## Public contract

`NodeLocalRunnerDeploymentLoader` has a zero-argument constructor and
zero-argument asynchronous `load()` method. It returns the existing:

```ts
Readonly<{
  configuration: LocalRunnerConfigurationV1;
  trustedImages: LocalRunnerTrustedImageCatalogConfigurationV1;
  credential: RunnerBearerToken;
}>;
```

`LocalRunnerDeploymentLoadError` is frozen and exposes only:

- `public_inputs_failed`;
- `credential_failed`; or
- `composition_failed`.

No public result or failure exposes a child loader, raw input, byte view, path,
descriptor, environment value, identity, metadata, child code, cause, or
nested error.

## Adversarial matrix

- construction performs no environment, identity, procfs, filesystem, process,
  network, clock, timer, random, logging, or lifecycle effect;
- production construction and `load()` expose no input or override authority;
- public load is called exactly once and always precedes credential-loader
  construction and invocation;
- public rejection or synchronous throw prevents every credential event;
- credential load is called exactly once only after public fulfillment;
- child rejection and synchronous throw normalize to their fixed stage;
- public properties are read once in fixed order only after credential success;
- throwing projection is `composition_failed` and does not leak its cause;
- successful output is frozen and contains the exact detached child values;
- child owners and post-call mutations cannot redirect the returned snapshot;
- repeated explicit calls create separate owners and ordered child calls; and
- every error string, serialization, and inspection remains free of public
  content, host authority, and credential material.

## Delivery order

1. Commit ADR-098 and this plan before production code.
2. Add the closed result/error contract and package-private deterministic join.
3. Bind the public production class to the two concrete child loaders.
4. Add deterministic ordering, failure, opacity, and redaction tests.
5. Add one real Linux fixed-fixture success test without duplicating child host
   matrices.
6. Prove fetch, observer, platform, bootstrap, signals, activation, and process
   entry remain absent.
7. Run every local and GitHub Actions gate before admitting ADR-098.

## Exit criteria

1. Invalid public deployment state causes zero credential-boundary effects.
2. Exactly one admitted credential joins exactly one complete public snapshot.
3. The returned existing deployment-input contract is frozen and contains no
   raw or host-owned representation.
4. Failures identify only the join stage and redact every child cause and
   secret-bearing value.
5. Deterministic tests prove composition semantics while real Linux CI proves
   the two already-hardened production loaders join successfully.
6. Platform composition, bootstrap, process entry, signals, activation, and
   runner enablement remain absent.

## Admission evidence

Architecture commit `db3e16d` preceded implementation commit `4fd741d`.
Implementation adds the closed join contract, package-private deterministic
core, concrete no-override production loader, public exports, and focused tests.
The credential child is constructed only inside its deferred second capability,
after complete public admission.

Nine deterministic tests prove exact public-before-secret ordering, one call per
stage, synchronous and asynchronous failure normalization, credential silence
after public failure, fixed projection order, immutable exact results, cause and
secret redaction, and repeated-call isolation. Three production-surface tests
prove inert frozen construction, a zero-argument API, unsupported-host
normalization at the public stage, and the real fixed Linux join.

All 1,399 locally runnable runner-local tests passed with thirteen Linux/
database-dependent branches deferred. Formatting, all 14-package type and lint
gates, both architecture audits, the database-free workspace suite, production
build, and local web/API HTTP 200 checks passed.

Main CI run `30740209107` passed 1,407 applicable runner-local tests across all
71 files with five intentionally inapplicable branches skipped. The new public
test joined the exact root-owned canonical public deployment tree with the exact
service-owned systemd credential fixture and returned one frozen admitted
snapshot. Existing focused public-deployment and credential adversarial runs,
fixture restoration and cleanup, PostgreSQL migrations and seeds, database and
API integrations, native spool and journal durability, the isolated Chromium
journey, production build, and both native evidence uploads also passed. Fetch,
observer, platform bootstrap, process entry, signals, activation, and runner
enablement remain absent.
