# Slice 2.18 frozen execution plan projection

Status: Complete

Date: 2026-07-31

Architecture: ADR-033, ADR-040, ADR-044, ADR-055

## Outcome

Produce one immutable, fully validated runtime request and OCI resource profile
from a frozen execution plus explicit trusted local policy, before any
side-effecting preparation begins.

## Boundary

Add a pure `execution` module to `services/runner-local`. It may depend on
contracts, runtime-protocol schemas, and OCI profile types. It cannot depend on
filesystem, image, engine, process, transport, journal, spool, clock, timer,
environment, or API modules. Production runner behavior remains unchanged.

## Trusted policy

Construction requires explicit positive limits for wall time, memory, PIDs,
aggregate writable bytes, runtime child output, and command count. It also
requires positive fixed `/tmp` and `/dev/shm` reservations plus integer cgroup
quota period, minimum quota, and maximum quota microseconds. Policy
relationships are validated at construction; the period must be a power of ten
so the OCI CPU value is a finite exact decimal. There are no implicit defaults.

## Projection

- identity is copied exactly from the frozen lease;
- source digest and action commands are copied from the immutable task;
- measurement identity, command, unit, revision, and result maximum are exact;
- runtime wall and command limits retain the frozen task values;
- runtime output is checked `logBytes + measurement.maximumBytes`;
- workspace bytes are checked
  `writableBytes - temporaryBytes - sharedMemoryBytes`;
- OCI writable mount sizes sum exactly to task writable bytes;
- CPU quota is
  `floor(cpuTimeMs * quotaPeriodMicros / wallTimeMs)`, using exact integer
  arithmetic, and CPU count is `quotaMicros / quotaPeriodMicros`;
- memory and PID limits remain exact;
- only network-disabled, zero-egress tasks are accepted.

## Failure matrix

- malformed execution or lease/task identity drift;
- malformed, zero, non-finite, unsafe, or relationally invalid policy;
- non-decimal cgroup quota period;
- every task limit independently above trusted maximum;
- writable subtraction underflow or zero workspace remainder;
- output addition overflow or trusted-output overflow;
- CPU ratio below minimum, above maximum, or below one quota quantum;
- proof that CPU rounding never increases the frozen allowance;
- allowlist networking or non-zero egress;
- command/measurement mutation after projection;
- attempts to introduce defaults, paths other than protocol constants, clocks,
  I/O, transport, execution, or persistence dependencies.

## Delivery order

1. Commit ADR-055 and this plan before production code.
2. Add strict local policy validation and closed projection result types.
3. Implement checked arithmetic and exact field mapping.
4. Add table, boundary, mutation, and property tests.
5. Run all local and GitHub Actions gates before admitting ADR-055.

## Exit criteria

1. Every runtime identity and command is frozen-task-derived.
2. Every projected resource is at or below both task and trusted policy.
3. Writable mount sizes equal, and never exceed, the aggregate task budget.
4. CPU quantization can only make enforcement stricter.
5. Unsupported networking and unrepresentable limits fail closed.
6. Projection is deterministic, immutable, and side-effect free.
7. No materialization, execution, event, or production enablement lands.
8. Full repository, native durability, browser, build, and CI gates pass.

## Evidence

Implementation commit `0c3a925`; GitHub Actions run `30657580224` passed 232
runner-local tests, all PostgreSQL/API/runner integrations, native spool and
journal durability, the Chromium product journey, and production builds.
Local format, type, lint, boundary audit, workspace test, property-test, and
build gates also passed.
