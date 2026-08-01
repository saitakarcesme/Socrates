# Slice 2.34 local attempt observation

Status: Complete

Date: 2026-08-01

Architecture: ADR-041, ADR-043, ADR-045, ADR-053, ADR-054, ADR-063, ADR-069,
ADR-070, ADR-071

## Outcome

Close one already-claimed execution into immutable local timing and candidate
observations. Do not acquire work, supervise authority, append terminal events,
complete journal work, or enable the runner.

## Observer contract

`AttemptExecutionObserver.observe()` is single-flight and returns the same
frozen result to every caller:

- `timing`: `not_started`, or `started` with a bounded elapsed duration;
- `candidate`: valid runtime drafts, one safe local failure draft, or `none`
  for an explicitly recognized authority abort.

The observer owns preparation, runtime execution, lifecycle adaptation, and
local capability release. Construction binds one parsed execution and its
already-bound durable start barrier. No mutable identity input is accepted at
call time.

Timing uncertainty is the only expected observation rejection: every caller
receives the same typed `timing_uncertain` rejection and no candidate. Execution
stage failures resolve through the closed candidate policy instead of rejecting.

## Stage normalization

Close failures while their stage is still known:

- projection -> `projection_rejected`;
- missing artifact -> `source_unavailable`;
- artifact or materialized-source mismatch -> `source_invalid`;
- image admission or identity rejection -> `image_rejected`;
- source materialization -> `source_materialization_failed`;
- request materialization -> `request_materialization_failed`;
- sandbox start or execution -> `sandbox_backend_failed`;
- frame decoding, exit contradiction, or lifecycle adaptation ->
  `runtime_protocol_invalid`;
- source, request, or sandbox cleanup uncertainty -> `cleanup_failed`;
- any other caught controlled failure -> `unexpected_runner_failure`.

Dependency errors must be wrapped inside the preparation, runtime, or backend
boundary that knows the stage. Messages and arbitrary causes never enter runner
event payloads.

Authority abort is not inferred from a late `signal.aborted` read. Only the
exact abort reason thrown by the signal or an explicit typed backend-aborted
error maps to candidate `none`. A failure observed independently of a later
abort retains its own candidate so ADR-069 can apply cancellation precedence.

## Durable timing

Add a single-flight `DurableExecutionTimingBarrier` around the existing start
barrier. It records an injected monotonic baseline after durable start succeeds
and before backend execution can begin. `snapshot()` returns:

- `not_started` before a successful crossing;
- `started` with `ceil(current - baseline)` afterward.

The duration must be finite, non-negative, and no greater than
`Number.MAX_SAFE_INTEGER`. Source failure, regression, overflow, or an invalid
reading rejects the shared observation as `timing_uncertain`. It cannot be
converted into zero and cannot create terminal evidence. Wall time and server
lease expiry are unreachable.

## Cleanup precedence

- preparation compensates for any source acquired before failure;
- runtime execution releases its request envelope after every backend outcome;
- the observer releases a successfully prepared source after adaptation or
  failure normalization;
- release is single-flight and receives the exact owned capability;
- any uncertain cleanup replaces an earlier runtime or failure candidate with
  `cleanup_failed`;
- an observer result proves all locally acquired capabilities are released.

## Failure matrix

- every preparation, runtime, adaptation, and cleanup stage fails alone;
- synchronous throw and asynchronous rejection at every dependency port;
- abort before preparation, during each stage, before durable start, during
  backend execution, and after an unrelated failure;
- durable barrier rejection, concurrent crossing, monotonic source throw,
  non-finite reading, regression, overflow, and fractional duration;
- runtime success, structured runtime failure, malformed protocol, and
  lifecycle contradiction;
- source release crossed with runtime success and runtime failure;
- concurrent and sequential `observe()` calls preserve exact Promise/result
  identity and never duplicate side effects;
- input, dependency-output, and returned-result mutation attempts;
- proof that transport, spool, authority monitor, journal completion,
  acquisition, and runner entry points are unreachable.

## Delivery order

1. Commit ADR-071 and this plan before production code.
2. Add typed stage errors without changing reachability.
3. Add durable monotonic timing around the existing start barrier.
4. Add the single-flight observer and closed failure normalizer.
5. Add adversarial stage, abort, timing, cleanup, and mutation tests.
6. Run every local and GitHub Actions gate before admitting ADR-071.

## Exit criteria

1. One observation performs each local side effect at most once.
2. Every caught stage failure closes to a safe candidate or explicit abort.
3. Timing begins only after durable execution start and never grants authority.
4. Cleanup uncertainty overrides all otherwise publishable local evidence.
5. Returned timing, candidates, drafts, and payloads are deeply immutable.
6. No event is appended and no lease, polling loop, or runner is enabled.

## Validation

Implementation commit `f750aa1` passed formatting, type checking, linting,
both architecture audits, every workspace test and build, and the low-severity
dependency audit. Focused proof comprises 13 observer and 11 timing tests; the
expanded preparation, runtime-executor, and OCI-backend suites contain 16, 19,
and 23 tests respectively. The complete runner-local suite contains 516 passing
tests.

GitHub Actions run `30710103241` passed PostgreSQL migrations and integrations,
authenticated API and runner integrations, both Linux native durability probes,
the Chromium product journey, and production builds. Disposable OCI
reference-host run `30710335532` passed rootless engine comparison, guarded
backend validation, and admitted runtime validation. Its generated backend
schema-v3 and runtime schema-v6 evidence both record forced exact-fence
termination and complete cleanup; runtime evidence also records source release
and the exact forced termination receipt.
