import { runnerExecutionV1Schema } from "@socrates/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  ExecutionPlanProjectionError,
  ExecutionPlanProjector,
  type LocalExecutionPolicy,
} from "./projector";
import taskFixture from "../../../../packages/contracts/fixtures/runner/task-v2.json";

const execution = runnerExecutionV1Schema.parse({
  version: "1",
  lease: {
    version: "1",
    runnerId: "10000000-0000-4000-8000-000000000001",
    taskId: taskFixture.taskId,
    attemptId: "20000000-0000-4000-8000-000000000002",
    fence: 3,
    leasedUntil: "2026-07-31T18:00:00.000Z",
  },
  task: taskFixture,
});

const mebibyte = 1_024 * 1_024;
const policy: LocalExecutionPolicy = {
  maximumWallTimeMs: 300_000,
  maximumMemoryBytes: 1_024 * mebibyte,
  maximumPids: 128,
  maximumWritableBytes: 1_024 * mebibyte,
  maximumRuntimeOutputBytes: 2 * mebibyte,
  maximumCommandCount: 3,
  temporaryBytes: 64 * mebibyte,
  sharedMemoryBytes: 64 * mebibyte,
  cpuQuotaPeriodMicros: 100_000,
  minimumCpuQuotaMicros: 1_000,
  maximumCpuQuotaMicros: 100_000,
};

function project(candidate = execution, configured = policy) {
  return new ExecutionPlanProjector(configured).project(candidate);
}

describe("ExecutionPlanProjector", () => {
  it("projects exact frozen identity, commands, measurement, and budgets", () => {
    const plan = project();
    const workspaceBytes =
      execution.task.budget.writableBytes -
      policy.temporaryBytes -
      policy.sharedMemoryBytes;

    expect(plan.request).toEqual({
      schema: "socrates.task-runtime.request.v1",
      identity: {
        runnerId: execution.lease.runnerId,
        taskId: execution.lease.taskId,
        attemptId: execution.lease.attemptId,
        fence: execution.lease.fence,
      },
      source: {
        digest: execution.task.source.digest,
        path: "/socrates/source",
      },
      actions: execution.task.action.steps,
      measurement: {
        metricDefinitionId: execution.task.measurement.metricDefinitionId,
        protocolRevision: execution.task.measurement.protocolRevision,
        unit: execution.task.measurement.unit,
        command: execution.task.measurement.command,
        maximumResultBytes: execution.task.measurement.result.maximumBytes,
      },
      budget: {
        wallTimeMs: execution.task.budget.wallTimeMs,
        writableBytes: workspaceBytes,
        outputBytes:
          execution.task.budget.logBytes +
          execution.task.measurement.result.maximumBytes,
        commandCount: execution.task.budget.commandCount,
      },
    });
    expect(plan.profile).toEqual({
      memoryBytes: execution.task.budget.memoryBytes,
      cpuCount: 0.8,
      maximumPids: execution.task.budget.maximumPids,
      workspaceBytes,
      temporaryBytes: policy.temporaryBytes,
      sharedMemoryBytes: policy.sharedMemoryBytes,
    });
    expect(
      plan.profile.workspaceBytes +
        plan.profile.temporaryBytes +
        plan.profile.sharedMemoryBytes,
    ).toBe(execution.task.budget.writableBytes);
  });

  it.each([
    ["maximumWallTimeMs", execution.task.budget.wallTimeMs - 1],
    ["maximumMemoryBytes", execution.task.budget.memoryBytes - 1],
    ["maximumPids", execution.task.budget.maximumPids - 1],
    ["maximumWritableBytes", execution.task.budget.writableBytes - 1],
    ["maximumRuntimeOutputBytes", execution.task.budget.logBytes],
    ["maximumCommandCount", execution.task.budget.commandCount - 1],
  ] as const)("rejects work above %s", (field, maximum) => {
    expect(() => project(execution, { ...policy, [field]: maximum })).toThrow(
      ExecutionPlanProjectionError,
    );
  });

  it("rejects malformed or relationally invalid trusted policy", () => {
    for (const configured of [
      { ...policy, maximumWallTimeMs: 0 },
      { ...policy, cpuQuotaPeriodMicros: Number.NaN },
      { ...policy, cpuQuotaPeriodMicros: 3_000 },
      {
        ...policy,
        minimumCpuQuotaMicros: policy.maximumCpuQuotaMicros + 1,
      },
      {
        ...policy,
        temporaryBytes: policy.maximumWritableBytes,
      },
    ]) {
      expect(() => new ExecutionPlanProjector(configured)).toThrow(
        ExecutionPlanProjectionError,
      );
    }
  });

  it("rejects writable underflow and checked output overflow", () => {
    const reserved = policy.temporaryBytes + policy.sharedMemoryBytes;
    expect(() =>
      project({
        ...execution,
        task: {
          ...execution.task,
          budget: { ...execution.task.budget, writableBytes: reserved },
        },
      }),
    ).toThrow("cannot represent all required tmpfs mounts");

    expect(() =>
      project(
        {
          ...execution,
          task: {
            ...execution.task,
            budget: {
              ...execution.task.budget,
              logBytes: Number.MAX_SAFE_INTEGER,
            },
          },
        },
        {
          ...policy,
          maximumRuntimeOutputBytes: Number.MAX_SAFE_INTEGER,
        },
      ),
    ).toThrow("exceeds safe integer arithmetic");
  });

  it("rejects CPU budgets outside the representable quota range", () => {
    expect(() =>
      project(
        {
          ...execution,
          task: {
            ...execution.task,
            budget: { ...execution.task.budget, cpuTimeMs: 1 },
          },
        },
        { ...policy, minimumCpuQuotaMicros: 1 },
      ),
    ).toThrow("outside the trusted representable quota range");
    expect(() =>
      project(execution, {
        ...policy,
        minimumCpuQuotaMicros: 80_001,
      }),
    ).toThrow("outside the trusted representable quota range");
    expect(() =>
      project(execution, {
        ...policy,
        maximumCpuQuotaMicros: 79_999,
      }),
    ).toThrow("outside the trusted representable quota range");
  });

  it("rejects network policy the local backend cannot enforce", () => {
    const networked = {
      ...execution,
      task: {
        ...execution.task,
        environment: {
          ...execution.task.environment,
          network: {
            mode: "allowlist" as const,
            destinations: [{ host: "example.com", ports: [443] }],
          },
          requiredCapabilities:
            execution.task.environment.requiredCapabilities.map((capability) =>
              capability.kind === "network.egress"
                ? ({ kind: "network.egress", mode: "allowlist" } as const)
                : capability,
            ),
        },
        budget: { ...execution.task.budget, egressBytes: 1 },
      },
    };

    expect(() => project(networked)).toThrow(
      "supports only disabled networking",
    );
  });

  it("returns a deeply immutable plan detached from caller mutation", () => {
    const candidate = structuredClone(execution);
    const plan = project(candidate);
    candidate.task.action.steps[0]!.arguments[0] = "changed";

    expect(plan.request.actions[0]?.arguments[0]).toBe(
      execution.task.action.steps[0]?.arguments[0],
    );
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.request.actions[0]?.arguments)).toBe(true);
    expect(() => {
      (plan.profile as { memoryBytes: number }).memoryBytes = 1;
    }).toThrow();
  });

  it("quantizes CPU downward for every admitted integer budget", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 60_000, max: 300_000 }).chain((wallTimeMs) =>
          fc.tuple(
            fc.constant(wallTimeMs),
            fc.integer({
              min: Math.ceil(wallTimeMs / 100_000),
              max: 600_000,
            }),
          ),
        ),
        ([wallTimeMs, cpuTimeMs]) => {
          const quotaPeriod = 100_000;
          const plan = project(
            {
              ...execution,
              task: {
                ...execution.task,
                action: {
                  ...execution.task.action,
                  steps: execution.task.action.steps.map((step) => ({
                    ...step,
                    timeoutMs: Math.min(step.timeoutMs, wallTimeMs),
                  })),
                },
                measurement: {
                  ...execution.task.measurement,
                  command: {
                    ...execution.task.measurement.command,
                    timeoutMs: Math.min(
                      execution.task.measurement.command.timeoutMs,
                      wallTimeMs,
                    ),
                  },
                },
                budget: {
                  ...execution.task.budget,
                  wallTimeMs,
                  cpuTimeMs,
                },
              },
            },
            {
              ...policy,
              minimumCpuQuotaMicros: 1,
              maximumCpuQuotaMicros: 1_000_000,
            },
          );
          const quotaMicros = Math.round(plan.profile.cpuCount * quotaPeriod);
          expect(BigInt(quotaMicros) * BigInt(wallTimeMs)).toBeLessThanOrEqual(
            BigInt(cpuTimeMs) * BigInt(quotaPeriod),
          );
        },
      ),
    );
  });
});
