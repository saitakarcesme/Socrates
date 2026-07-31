import {
  runnerExecutionV1Schema,
  type RunnerExecutionV1,
} from "@socrates/contracts";
import {
  runtimeRequestSchema,
  type RuntimeRequest,
} from "@socrates/runtime-protocol";

import {
  validateSandboxProfile,
  type SandboxResourceProfile,
} from "../oci/profile";

export type LocalExecutionPolicy = Readonly<{
  maximumWallTimeMs: number;
  maximumMemoryBytes: number;
  maximumPids: number;
  maximumWritableBytes: number;
  maximumRuntimeOutputBytes: number;
  maximumCommandCount: number;
  temporaryBytes: number;
  sharedMemoryBytes: number;
  cpuQuotaPeriodMicros: number;
  minimumCpuQuotaMicros: number;
  maximumCpuQuotaMicros: number;
}>;

export type ProjectedExecutionPlan = Readonly<{
  request: RuntimeRequest;
  profile: SandboxResourceProfile;
}>;

export class ExecutionPlanProjectionError extends Error {
  constructor(
    readonly code:
      | "invalid_policy"
      | "policy_exceeded"
      | "unrepresentable_budget"
      | "unsupported_network",
    message: string,
  ) {
    super(message);
    this.name = "ExecutionPlanProjectionError";
  }
}

function positiveSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ExecutionPlanProjectionError(
      "invalid_policy",
      `${name} must be a positive safe integer.`,
    );
  }
}

function validatePolicy(candidate: LocalExecutionPolicy): LocalExecutionPolicy {
  for (const [name, value] of Object.entries(candidate)) {
    positiveSafeInteger(name, value);
  }
  if (candidate.minimumCpuQuotaMicros > candidate.maximumCpuQuotaMicros) {
    throw new ExecutionPlanProjectionError(
      "invalid_policy",
      "Minimum CPU quota cannot exceed maximum CPU quota.",
    );
  }
  if (!/^10*$/u.test(String(candidate.cpuQuotaPeriodMicros))) {
    throw new ExecutionPlanProjectionError(
      "invalid_policy",
      "CPU quota period must be a power of ten.",
    );
  }
  const reserved = checkedAdd(
    candidate.temporaryBytes,
    candidate.sharedMemoryBytes,
    "Writable reservation",
    "invalid_policy",
  );
  if (reserved >= candidate.maximumWritableBytes) {
    throw new ExecutionPlanProjectionError(
      "invalid_policy",
      "Writable reservations must leave positive workspace capacity.",
    );
  }
  return Object.freeze({ ...candidate });
}

function checkedAdd(
  left: number,
  right: number,
  name: string,
  code: "invalid_policy" | "unrepresentable_budget",
): number {
  const value = left + right;
  if (!Number.isSafeInteger(value)) {
    throw new ExecutionPlanProjectionError(
      code,
      `${name} exceeds safe integer arithmetic.`,
    );
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function exceeds(value: number, maximum: number, name: string): void {
  if (value > maximum) {
    throw new ExecutionPlanProjectionError(
      "policy_exceeded",
      `${name} exceeds trusted local policy.`,
    );
  }
}

export class ExecutionPlanProjector {
  readonly #policy: LocalExecutionPolicy;

  constructor(policy: LocalExecutionPolicy) {
    this.#policy = validatePolicy(policy);
  }

  project(candidate: RunnerExecutionV1): ProjectedExecutionPlan {
    const execution = runnerExecutionV1Schema.parse(candidate);
    const { budget } = execution.task;
    exceeds(budget.wallTimeMs, this.#policy.maximumWallTimeMs, "Wall time");
    exceeds(budget.memoryBytes, this.#policy.maximumMemoryBytes, "Memory");
    exceeds(budget.maximumPids, this.#policy.maximumPids, "PID count");
    exceeds(
      budget.writableBytes,
      this.#policy.maximumWritableBytes,
      "Writable bytes",
    );
    exceeds(
      budget.commandCount,
      this.#policy.maximumCommandCount,
      "Command count",
    );

    if (
      execution.task.environment.network.mode !== "disabled" ||
      budget.egressBytes !== 0
    ) {
      throw new ExecutionPlanProjectionError(
        "unsupported_network",
        "The local execution backend supports only disabled networking.",
      );
    }

    const reservedWritableBytes = checkedAdd(
      this.#policy.temporaryBytes,
      this.#policy.sharedMemoryBytes,
      "Writable reservation",
      "invalid_policy",
    );
    const workspaceBytes = budget.writableBytes - reservedWritableBytes;
    if (!Number.isSafeInteger(workspaceBytes) || workspaceBytes < 1) {
      throw new ExecutionPlanProjectionError(
        "unrepresentable_budget",
        "Task writable budget cannot represent all required tmpfs mounts.",
      );
    }

    const outputBytes = checkedAdd(
      budget.logBytes,
      execution.task.measurement.result.maximumBytes,
      "Runtime output budget",
      "unrepresentable_budget",
    );
    exceeds(
      outputBytes,
      this.#policy.maximumRuntimeOutputBytes,
      "Runtime output",
    );

    const quotaNumerator =
      BigInt(budget.cpuTimeMs) * BigInt(this.#policy.cpuQuotaPeriodMicros);
    const quotaMicros = quotaNumerator / BigInt(budget.wallTimeMs);
    if (
      quotaMicros < BigInt(this.#policy.minimumCpuQuotaMicros) ||
      quotaMicros > BigInt(this.#policy.maximumCpuQuotaMicros)
    ) {
      throw new ExecutionPlanProjectionError(
        "unrepresentable_budget",
        "Task CPU budget is outside the trusted representable quota range.",
      );
    }
    if (quotaMicros * BigInt(budget.wallTimeMs) > quotaNumerator) {
      throw new ExecutionPlanProjectionError(
        "unrepresentable_budget",
        "Projected CPU quota would weaken the frozen task budget.",
      );
    }
    const cpuCount = Number(quotaMicros) / this.#policy.cpuQuotaPeriodMicros;
    if (!Number.isFinite(cpuCount) || cpuCount <= 0) {
      throw new ExecutionPlanProjectionError(
        "unrepresentable_budget",
        "Projected CPU count is not representable.",
      );
    }

    const request = runtimeRequestSchema.parse({
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
        wallTimeMs: budget.wallTimeMs,
        writableBytes: workspaceBytes,
        outputBytes,
        commandCount: budget.commandCount,
      },
    });
    const profile: SandboxResourceProfile = {
      memoryBytes: budget.memoryBytes,
      cpuCount,
      maximumPids: budget.maximumPids,
      workspaceBytes,
      temporaryBytes: this.#policy.temporaryBytes,
      sharedMemoryBytes: this.#policy.sharedMemoryBytes,
    };
    validateSandboxProfile(profile);

    return deepFreeze({ request, profile });
  }
}
