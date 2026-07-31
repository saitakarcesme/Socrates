# Slice 2.8 runtime lifecycle event adapter plan

Status: Complete

Date: 2026-07-31

Architecture: ADR-037, ADR-040, ADR-044, ADR-045

## Outcome

Translate one admitted task-runtime result into an ordered, bounded set of
runner event drafts. The slice validates measurement evidence and log safety but
does not assign durable envelopes, communicate with the control plane, or
enable the production local runner.

## Boundary

Add a `lifecycle` module to `services/runner-local`. Its input contains the
validated `RunnerExecutionV1`, admitted image digest, source digest, and
`RuntimeSandboxResult`. Its output is an immutable discriminated union of V2
event type/payload drafts.

The module may depend on contracts and runtime-protocol types. It cannot depend
on the database, API, transport, filesystem, OCI engine, or wall clock. Event
envelopes belong to the durable spool in Slice 2.9.

Move the existing pure credential-pattern policy into the execution-neutral
`@socrates/evidence-policy` package. Both database ingestion and the local
adapter call it independently; neither trusts the other's `redacted` flag.

## Mapping

1. Emit `workspace.prepared` from admitted source and image identities only
   when the first command-start frame proves runtime source preparation passed.
2. Map action `command.started` frames to `action.started`.
3. Decode, redact, and contract-chunk action stdout/stderr into `log.appended`.
4. Map numeric action exits to `action.completed`; do not synthesize an exit
   code for a signal-only exit.
5. Suppress measurement stdout logs because the same bytes are carried by
   `measurement.result`; retain redacted measurement stderr logs.
6. Join the independently sequenced measurement chunks, validate fatal UTF-8,
   strict JSON `{schema,value}`, schema `metric-value.v1`, and canonical decimal
   value, then emit one `measurement.recorded` with the frozen metric ID/unit
   and `sampleCount: 1`.
7. Emit exactly one terminal `task.succeeded` or `task.failed` draft.

Numeric command durations pass through unchanged. The outer sandbox duration is
rounded up to the next millisecond for integer terminal-event fields so elapsed
time is never understated.

## Failure policy

| Runtime condition                          | Event classification   | Budget dimension |
| ------------------------------------------ | ---------------------- | ---------------- |
| `invalid_request`                          | `infrastructure`       | none             |
| `source_copy_failed`                       | `infrastructure`       | none             |
| action `command_failed`                    | `invalid_action`       | none             |
| `measurement_failed`                       | `evaluation`           | none             |
| `command_timeout`                          | `budget`               | `wall_time`      |
| `output_budget_exceeded`                   | `budget`               | `log_bytes`      |
| `internal_error`                           | `infrastructure`       | none             |
| malformed measurement/result contradiction | adapter protocol error | no event list    |

Messages are fixed adapter-owned text. Runtime error message text is never used
for classification or copied into durable events.

## Log policy

- Reassemble each command stream within the already-enforced output bound.
- Decode continuously so frame boundaries cannot corrupt split code points.
- Replace invalid UTF-8 deterministically and mark the affected output redacted.
- Apply the runner secret redactor before chunking so tokens split across runtime
  frames cannot bypass it.
- Split by Unicode code point within both V2 text and UTF-8 byte limits.
- Preserve runtime command/stream order and emit inert text only.
- Reject any transformation whose aggregate output exceeds the task log budget;
  budget exhaustion becomes `task.failed` with dimension `log_bytes`.

## Adversarial matrix

- reordered, duplicated, missing, or contradictory terminal frames;
- action index and phase mismatches;
- UTF-8 code points split across frames and invalid binary sequences;
- secrets split across frames and chunk boundaries;
- exact text/byte boundary values and aggregate log-budget exhaustion;
- measurement stdout duplication attempts;
- malformed, non-canonical, extra-field, oversized, NaN, exponent, and wrong-unit
  measurement results;
- signal-only exits and every structured runtime error mapping;
- mutation of task, frame, and returned draft objects;
- attempts to introduce event IDs, sequence, timestamps, paths, or transport
  state into the adapter.

## Delivery order

1. Define the internal event-draft schemas and compile-time exhaustiveness.
2. Implement deterministic log decoding, redaction, byte accounting, and
   chunking behind a pure port.
3. Implement strict measurement result validation.
4. Implement the frame-to-draft state machine and closed failure mapping.
5. Add property and adversarial tests.
6. Run full repository gates and amend ADR-045 with validation evidence.

## Exit criteria

1. Every successful runtime sequence yields workspace, action, measurement, and
   success drafts in deterministic order.
2. Every admitted runtime failure maps to exactly one closed failure draft.
3. Invalid measurement or frame semantics cannot emit partial event lists.
4. Logs are redacted, inert, bounded, and contract-valid.
5. The adapter has no clock, persistence, engine, transport, or host-path input.
6. `LocalRunnerNotEnabledError` remains the production behavior.
7. Full workspace quality and dependency-boundary gates pass.

## Validation

Completed on 2026-07-31.

- all 13 workspaces passed formatting, typecheck, lint, test, and build gates;
- Phase 1 and Phase 2 dependency-boundary audits passed;
- the dependency audit reported no known vulnerabilities at low severity;
- runner-local passed 124 tests with three environment-gated integration tests
  skipped;
- task-runtime passed 20 tests with one platform-gated test skipped;
- the shared evidence policy passed two tests;
- production runner enablement remains explicitly out of scope.
