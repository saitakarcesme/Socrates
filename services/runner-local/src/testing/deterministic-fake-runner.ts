import { createHash } from "node:crypto";

import {
  runnerCancellationV1Schema,
  runnerEventV2Schema,
  runnerExecutionV1Schema,
} from "@socrates/contracts";

import type {
  RunnerCancellationV1,
  RunnerEventV2,
  RunnerExecutionV1,
} from "@socrates/contracts";
import type { Runner } from "../index";

export type DeterministicFakeRunnerOptions = {
  measurementAmount: string;
  sampleCount?: number;
  actionDurationMs?: number;
  totalDurationMs?: number;
  occurredAt?: string;
};

function deterministicEventId(attemptId: string, sequence: number): string {
  const hex = createHash("sha256")
    .update(`${attemptId}:${sequence}`)
    .digest("hex")
    .slice(0, 32)
    .split("");
  hex[12] = "4";
  hex[16] = "8";
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function executionIdentity(execution: RunnerExecutionV1): string {
  const { lease } = execution;
  return `${lease.runnerId}:${lease.taskId}:${lease.attemptId}:${lease.fence}`;
}

export class DeterministicFakeRunner implements Runner {
  readonly kind = "local" as const;
  private readonly cancelled = new Set<string>();
  private readonly options: Required<DeterministicFakeRunnerOptions>;

  constructor(options: DeterministicFakeRunnerOptions) {
    this.options = {
      measurementAmount: options.measurementAmount,
      sampleCount: options.sampleCount ?? 1,
      actionDurationMs: options.actionDurationMs ?? 10,
      totalDurationMs: options.totalDurationMs ?? 100,
      occurredAt: options.occurredAt ?? "2026-07-31T00:00:00.000Z",
    };
    for (const [name, value] of [
      ["sampleCount", this.options.sampleCount],
      ["actionDurationMs", this.options.actionDurationMs],
      ["totalDurationMs", this.options.totalDurationMs],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new RangeError(`${name} must be a positive safe integer.`);
      }
    }
  }

  async cancel(input: RunnerCancellationV1): Promise<void> {
    const cancellation = runnerCancellationV1Schema.parse(input);
    this.cancelled.add(
      `${cancellation.runnerId}:${cancellation.taskId}:${cancellation.attemptId}:${cancellation.fence}`,
    );
  }

  async *execute(input: RunnerExecutionV1): AsyncIterable<RunnerEventV2> {
    const execution = runnerExecutionV1Schema.parse(input);
    let sequence = 0;

    const next = (
      type: RunnerEventV2["type"],
      payload: RunnerEventV2["payload"],
    ): RunnerEventV2 => {
      sequence += 1;
      return runnerEventV2Schema.parse({
        version: "2",
        eventId: deterministicEventId(execution.lease.attemptId, sequence),
        runnerId: execution.lease.runnerId,
        taskId: execution.lease.taskId,
        attemptId: execution.lease.attemptId,
        fence: execution.lease.fence,
        sequence,
        occurredAt: this.options.occurredAt,
        type,
        payload,
      });
    };
    const cancelled = () => this.cancelled.has(executionIdentity(execution));
    const cancellationEvent = () =>
      next("task.cancelled", {
        forced: false,
        durationMs: this.options.totalDurationMs,
      });

    if (cancelled()) {
      yield cancellationEvent();
      return;
    }
    yield next("workspace.prepared", {
      sourceDigest: execution.task.source.digest,
      imageDigest: execution.task.environment.imageDigest,
    });

    for (const [commandIndex] of execution.task.action.steps.entries()) {
      if (cancelled()) {
        yield cancellationEvent();
        return;
      }
      yield next("action.started", { commandIndex });
      if (cancelled()) {
        yield cancellationEvent();
        return;
      }
      yield next("action.completed", {
        commandIndex,
        exitCode: 0,
        durationMs: this.options.actionDurationMs,
      });
    }

    if (cancelled()) {
      yield cancellationEvent();
      return;
    }
    yield next("measurement.recorded", {
      metricDefinitionId: execution.task.measurement.metricDefinitionId,
      amount: this.options.measurementAmount,
      unit: execution.task.measurement.unit,
      sampleCount: this.options.sampleCount,
    });
    if (cancelled()) {
      yield cancellationEvent();
      return;
    }
    yield next("task.succeeded", {
      exitCode: 0,
      durationMs: this.options.totalDurationMs,
    });
  }
}
