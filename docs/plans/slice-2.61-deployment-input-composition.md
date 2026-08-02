# Slice 2.61 deployment input composition

Status: Planned

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
