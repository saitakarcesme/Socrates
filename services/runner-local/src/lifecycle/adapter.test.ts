import { runnerExecutionV1Schema } from "@socrates/contracts";
import {
  runtimeFrameSchema,
  type RuntimeFrame,
} from "@socrates/runtime-protocol";
import { describe, expect, it } from "vitest";

import {
  RuntimeLifecycleAdapterError,
  runtimeLifecycleDrafts,
} from "./adapter";
import taskFixture from "../../../../packages/contracts/fixtures/runner/task-v2.json";

const execution = runnerExecutionV1Schema.parse({
  version: "1",
  lease: {
    version: "1",
    runnerId: "10000000-0000-4000-8000-000000000001",
    taskId: taskFixture.taskId,
    attemptId: "20000000-0000-4000-8000-000000000002",
    fence: 1,
    leasedUntil: "2026-07-31T18:00:00.000Z",
  },
  task: taskFixture,
});

function encoded(value: string): string {
  return Buffer.from(value).toString("base64");
}

function successFrames(
  measurement = '{"schema":"metric-value.v1","value":"1.25"}',
) {
  return [
    { type: "command.started", phase: "action", commandIndex: 0 },
    {
      type: "command.output",
      phase: "action",
      commandIndex: 0,
      stream: "stdout",
      sequence: 0,
      bytes: encoded("Authorization: Bearer abcdefghijklmnop"),
    },
    {
      type: "command.exited",
      phase: "action",
      commandIndex: 0,
      exitCode: 0,
      signal: null,
      durationMs: 4,
    },
    { type: "command.started", phase: "measurement", commandIndex: 0 },
    {
      type: "command.output",
      phase: "measurement",
      commandIndex: 0,
      stream: "stdout",
      sequence: 0,
      bytes: encoded(measurement),
    },
    {
      type: "command.output",
      phase: "measurement",
      commandIndex: 0,
      stream: "stderr",
      sequence: 1,
      bytes: encoded("measurement diagnostic"),
    },
    {
      type: "command.exited",
      phase: "measurement",
      commandIndex: 0,
      exitCode: 0,
      signal: null,
      durationMs: 5,
    },
    {
      type: "measurement.result",
      sequence: 0,
      final: true,
      bytes: encoded(measurement),
    },
    { type: "runtime.completed", status: "succeeded" },
  ].map((frame) => runtimeFrameSchema.parse(frame));
}

function result(
  frames: readonly RuntimeFrame[],
  status: "failed" | "succeeded",
) {
  return { frames, status, durationMs: 12.2 } as const;
}

function input(
  frames: readonly RuntimeFrame[],
  status: "failed" | "succeeded",
) {
  return {
    execution,
    sourceDigest: execution.task.source.digest,
    imageDigest: execution.task.environment.imageDigest,
    result: result(frames, status),
  };
}

describe("runtime lifecycle adapter", () => {
  it("maps successful runtime evidence to bounded drafts without measurement stdout duplication", () => {
    const drafts = runtimeLifecycleDrafts(input(successFrames(), "succeeded"));

    expect(drafts.map((draft) => draft.type)).toEqual([
      "workspace.prepared",
      "action.started",
      "log.appended",
      "action.completed",
      "log.appended",
      "measurement.recorded",
      "task.succeeded",
    ]);
    expect(drafts[2]).toMatchObject({
      payload: {
        text: "Authorization: Bearer [REDACTED]",
        redacted: true,
      },
    });
    expect(drafts[4]).toMatchObject({
      payload: { text: "measurement diagnostic", stream: "stderr" },
    });
    expect(drafts[5]).toEqual({
      type: "measurement.recorded",
      payload: {
        metricDefinitionId: execution.task.measurement.metricDefinitionId,
        amount: "1.25",
        unit: execution.task.measurement.unit,
        sampleCount: 1,
      },
    });
    expect(drafts.at(-1)).toEqual({
      type: "task.succeeded",
      payload: { exitCode: 0, durationMs: 13 },
    });
  });

  it.each([
    ["invalid_request", "infrastructure", undefined],
    ["source_copy_failed", "infrastructure", undefined],
    ["command_failed", "invalid_action", undefined],
    ["command_timeout", "budget", "wall_time"],
    ["output_budget_exceeded", "budget", "log_bytes"],
    ["measurement_failed", "evaluation", undefined],
    ["internal_error", "infrastructure", undefined],
  ] as const)(
    "maps %s to a closed failure policy",
    (code, classification, budgetDimension) => {
      const frames = [
        { type: "runtime.error", code, message: "untrusted runtime text" },
        { type: "runtime.completed", status: "failed" },
      ].map((frame) => runtimeFrameSchema.parse(frame));

      expect(runtimeLifecycleDrafts(input(frames, "failed")).at(-1)).toEqual({
        type: "task.failed",
        payload: {
          classification,
          ...(budgetDimension ? { budgetDimension } : {}),
          message: expect.not.stringContaining("untrusted"),
        },
      });
      if (code === "source_copy_failed" || code === "invalid_request") {
        expect(runtimeLifecycleDrafts(input(frames, "failed"))).toHaveLength(1);
      }
    },
  );

  it("does not invent a numeric action exit code for a signal", () => {
    const frames = [
      { type: "command.started", phase: "action", commandIndex: 0 },
      {
        type: "command.exited",
        phase: "action",
        commandIndex: 0,
        exitCode: null,
        signal: "SIGKILL",
        durationMs: 2,
      },
      {
        type: "runtime.error",
        code: "command_failed",
        message: "Runtime command failed.",
      },
      { type: "runtime.completed", status: "failed" },
    ].map((frame) => runtimeFrameSchema.parse(frame));
    const drafts = runtimeLifecycleDrafts(input(frames, "failed"));

    expect(drafts.map((draft) => draft.type)).toEqual([
      "workspace.prepared",
      "action.started",
      "task.failed",
    ]);
  });

  it("turns local log quota exhaustion into a terminal budget draft", () => {
    const limitedExecution = runnerExecutionV1Schema.parse({
      ...execution,
      task: {
        ...execution.task,
        budget: { ...execution.task.budget, logBytes: 3 },
      },
    });
    const drafts = runtimeLifecycleDrafts({
      ...input(successFrames(), "succeeded"),
      execution: limitedExecution,
    });

    expect(drafts.at(-1)).toEqual({
      type: "task.failed",
      payload: {
        classification: "budget",
        budgetDimension: "log_bytes",
        message: "Runtime logs exceeded the frozen log byte budget.",
      },
    });
    expect(drafts.some((draft) => draft.type === "task.succeeded")).toBe(false);
  });

  it("rejects invalid measurement, identity, and terminal contradictions without drafts", () => {
    expect(() =>
      runtimeLifecycleDrafts(
        input(
          successFrames('{"schema":"metric-value.v1","value":"01"}'),
          "succeeded",
        ),
      ),
    ).toThrow();
    expect(() =>
      runtimeLifecycleDrafts({
        ...input(successFrames(), "succeeded"),
        imageDigest: `sha256:${"d".repeat(64)}`,
      }),
    ).toThrow(RuntimeLifecycleAdapterError);
    expect(() =>
      runtimeLifecycleDrafts(input(successFrames(), "failed")),
    ).toThrow(RuntimeLifecycleAdapterError);
  });

  it("rejects nondeterministic stream order and freezes the returned list", () => {
    const frames = successFrames();
    const actionOutput = frames[1];
    if (actionOutput?.type !== "command.output") {
      throw new Error("Expected action output fixture.");
    }
    const reordered = [
      frames[0]!,
      { ...actionOutput, stream: "stderr", sequence: 0 } as const,
      { ...actionOutput, stream: "stdout", sequence: 1 } as const,
      ...frames.slice(2),
    ];
    expect(() => runtimeLifecycleDrafts(input(reordered, "succeeded"))).toThrow(
      /deterministic order/u,
    );

    const drafts = runtimeLifecycleDrafts(input(successFrames(), "succeeded"));
    expect(Object.isFrozen(drafts)).toBe(true);
    expect(drafts.every((draft) => Object.isFrozen(draft))).toBe(true);
  });
});
