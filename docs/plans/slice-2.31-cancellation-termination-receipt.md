# Slice 2.31 cancellation termination receipt

Status: Planned

Date: 2026-08-01

Architecture: ADR-050, ADR-062, ADR-063, ADR-068

## Outcome

Carry an authoritative graceful, forced, or absent sandbox termination result
from the OCI backend through cancellation supervision without inventing
terminal evidence.

## Receipt contract

`SandboxTerminationReceipt` is a deeply frozen union:

- `{ state: "absent" }` when no exact active attempt owns a sandbox;
- `{ state: "terminated", forced: false }` after successful graceful stop;
- `{ state: "terminated", forced: true }` only after failed graceful stop and
  successful bounded kill.

Disappearance during cancellation resolves as absent. Timeout, engine,
unclassified response, kill, and cleanup uncertainty reject without a receipt.

## Backend ordering

1. Validate identity and grace before process effects.
2. Resolve only the exact active full-fence ownership record.
3. Attempt one bounded graceful stop.
4. Skip kill after authoritative graceful success.
5. Escalate once after authoritative graceful failure.
6. Require successful kill or authoritative disappearance.
7. Remove exact owned resources before returning a receipt.

## Propagation

- cancellation scope returns and memoizes the exact receipt;
- exact duplicate cancellation joins the same promise and object;
- lease supervisor includes the receipt in authenticated cancellation results;
- lease authority monitor preserves that receipt in its cancellation result;
- local revocation awaits the receipt but publishes no terminal fact.

## Failure matrix

- invalid identity and grace before process effects;
- exact-fence miss and cancellation before sandbox creation;
- graceful stop success without kill;
- graceful nonzero followed by successful kill;
- container disappearance during stop or kill;
- stop timeout/throw, failed kill, and failed removal;
- cancellation racing natural execution cleanup;
- exact duplicate and conflicting cancellation/revocation calls;
- supervisor and monitor receipt identity preservation;
- native stubborn-process proof reports forced termination.

## Delivery order

1. Commit ADR-068 and this plan before production code.
2. Replace the backend boolean with the receipt union.
3. Make graceful/forced escalation explicit and checked.
4. Propagate receipts through cancellation scope, supervisor, and monitor.
5. Update native evidence schemas and assertions.
6. Add deterministic unit, race, and native tests.
7. Run every local and GitHub Actions gate before admitting ADR-068.

## Exit criteria

1. `forced` is observed, never inferred by the session.
2. Successful graceful stop does not issue kill.
3. Forced receipt requires a successful escalation.
4. Uncertainty cannot produce a receipt or terminal evidence.
5. Exact duplicates share one result and one backend operation.
6. Session composition, outcome arbitration, polling, and runner enablement
   remain disabled.
