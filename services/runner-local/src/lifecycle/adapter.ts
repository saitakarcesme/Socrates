import {
  runnerExecutionV1Schema,
  sha256DigestSchema,
  type RunnerExecutionV1,
} from "@socrates/contracts";
import {
  RuntimeFrameSequenceValidator,
  runtimeFrameSchema,
  type RuntimeFrame,
} from "@socrates/runtime-protocol";

import { runnerEventDraft, type RunnerEventDraft } from "./draft";
import { RuntimeLogBudgetError, runtimeLogDrafts } from "./log";
import { runtimeMeasurementDraft } from "./measurement";
import type { RuntimeSandboxResult } from "../runtime/executor";

export class RuntimeLifecycleAdapterError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeLifecycleAdapterError";
  }
}

type OutputState = {
  stdout: Uint8Array[];
  stderr: Uint8Array[];
  stderrSeen: boolean;
};

const failurePolicy = {
  invalid_request: {
    classification: "infrastructure",
    message: "The admitted runtime rejected its runner request.",
  },
  source_copy_failed: {
    classification: "infrastructure",
    message: "The admitted runtime could not prepare its source snapshot.",
  },
  command_failed: {
    classification: "invalid_action",
    message: "An action command failed.",
  },
  command_timeout: {
    classification: "budget",
    budgetDimension: "wall_time",
    message: "A command exceeded its wall-time budget.",
  },
  output_budget_exceeded: {
    classification: "budget",
    budgetDimension: "log_bytes",
    message: "Runtime output exceeded the frozen log byte budget.",
  },
  measurement_failed: {
    classification: "evaluation",
    message: "The measurement command failed.",
  },
  internal_error: {
    classification: "infrastructure",
    message: "The admitted runtime encountered an internal error.",
  },
} as const;

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "base64"));
}

function terminalDuration(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RuntimeLifecycleAdapterError(
      "Runtime duration must be a non-negative finite number.",
    );
  }
  const duration = Math.ceil(value);
  if (!Number.isSafeInteger(duration)) {
    throw new RuntimeLifecycleAdapterError(
      "Runtime duration exceeds the event contract.",
    );
  }
  return duration;
}

function validateFrames(
  frames: readonly RuntimeFrame[],
  actionCount: number,
): readonly RuntimeFrame[] {
  try {
    const parsed = frames.map((frame) => runtimeFrameSchema.parse(frame));
    const validator = new RuntimeFrameSequenceValidator({
      mode: "execution",
      actionCount,
    });
    for (const frame of parsed) validator.accept(frame);
    validator.finish();
    return parsed;
  } catch (cause) {
    throw new RuntimeLifecycleAdapterError(
      "Runtime frame sequence is not valid lifecycle evidence.",
      { cause },
    );
  }
}

export function runtimeLifecycleDrafts(input: {
  execution: RunnerExecutionV1;
  sourceDigest: string;
  imageDigest: string;
  result: RuntimeSandboxResult;
}): readonly RunnerEventDraft[] {
  const execution = runnerExecutionV1Schema.parse(input.execution);
  const sourceDigest = sha256DigestSchema.parse(input.sourceDigest);
  const imageDigest = sha256DigestSchema.parse(input.imageDigest);
  if (
    sourceDigest !== execution.task.source.digest ||
    imageDigest !== execution.task.environment.imageDigest
  ) {
    throw new RuntimeLifecycleAdapterError(
      "Runtime evidence identity does not match the frozen task.",
    );
  }
  const frames = validateFrames(
    input.result.frames,
    execution.task.action.steps.length,
  );
  const terminal = frames.at(-1);
  if (
    terminal?.type !== "runtime.completed" ||
    terminal.status !== input.result.status
  ) {
    throw new RuntimeLifecycleAdapterError(
      "Runtime result contradicts its terminal frame.",
    );
  }

  const drafts: RunnerEventDraft[] = [];
  let workspacePrepared = false;
  let output: OutputState | undefined;
  let activePhase: "action" | "measurement" | undefined;
  let usedLogBytes = 0;
  const measurementChunks: Uint8Array[] = [];
  let runtimeError:
    Extract<RuntimeFrame, { type: "runtime.error" }> | undefined;

  const appendLogs = (stream: "stderr" | "stdout", chunks: Uint8Array[]) => {
    if (chunks.length === 0) return;
    const logs = runtimeLogDrafts({
      stream,
      chunks,
      remainingBudgetBytes: execution.task.budget.logBytes - usedLogBytes,
    });
    drafts.push(...logs.drafts);
    usedLogBytes += logs.utf8Bytes;
  };
  const appendWorkspace = () => {
    if (workspacePrepared) return;
    drafts.push(
      runnerEventDraft({
        type: "workspace.prepared",
        payload: { sourceDigest, imageDigest },
      }),
    );
    workspacePrepared = true;
  };

  try {
    for (const frame of frames) {
      switch (frame.type) {
        case "command.started":
          appendWorkspace();
          activePhase = frame.phase;
          output = { stdout: [], stderr: [], stderrSeen: false };
          if (frame.phase === "action") {
            drafts.push(
              runnerEventDraft({
                type: "action.started",
                payload: { commandIndex: frame.commandIndex },
              }),
            );
          }
          break;
        case "command.output":
          if (!output || activePhase !== frame.phase) {
            throw new RuntimeLifecycleAdapterError(
              "Runtime output has no matching active command.",
            );
          }
          if (frame.stream === "stderr") output.stderrSeen = true;
          if (frame.stream === "stdout" && output.stderrSeen) {
            throw new RuntimeLifecycleAdapterError(
              "Runtime command streams are not in deterministic order.",
            );
          }
          output[frame.stream].push(decodeBase64(frame.bytes));
          break;
        case "command.exited":
          if (!output || activePhase !== frame.phase) {
            throw new RuntimeLifecycleAdapterError(
              "Runtime exit has no matching active command.",
            );
          }
          if (frame.phase === "action") {
            appendLogs("stdout", output.stdout);
            appendLogs("stderr", output.stderr);
            if (frame.exitCode !== null) {
              drafts.push(
                runnerEventDraft({
                  type: "action.completed",
                  payload: {
                    commandIndex: frame.commandIndex,
                    exitCode: frame.exitCode,
                    durationMs: frame.durationMs,
                  },
                }),
              );
            }
          } else {
            appendLogs("stderr", output.stderr);
          }
          output = undefined;
          activePhase = undefined;
          break;
        case "measurement.result":
          measurementChunks.push(decodeBase64(frame.bytes));
          break;
        case "runtime.error":
          runtimeError = frame;
          break;
        case "runtime.completed":
        case "runtime.handshake":
          break;
      }
    }
  } catch (cause) {
    if (cause instanceof RuntimeLogBudgetError) {
      drafts.push(
        runnerEventDraft({
          type: "task.failed",
          payload: {
            classification: "budget",
            budgetDimension: "log_bytes",
            message: "Runtime logs exceeded the frozen log byte budget.",
          },
        }),
      );
      return Object.freeze(drafts);
    }
    throw cause;
  }

  if (input.result.status === "succeeded") {
    if (runtimeError) {
      throw new RuntimeLifecycleAdapterError(
        "Successful runtime evidence contains an error frame.",
      );
    }
    drafts.push(
      runtimeMeasurementDraft({
        chunks: measurementChunks,
        measurement: execution.task.measurement,
      }),
      runnerEventDraft({
        type: "task.succeeded",
        payload: {
          exitCode: 0,
          durationMs: terminalDuration(input.result.durationMs),
        },
      }),
    );
  } else {
    if (!runtimeError) {
      throw new RuntimeLifecycleAdapterError(
        "Failed runtime evidence omitted its structured error.",
      );
    }
    drafts.push(
      runnerEventDraft({
        type: "task.failed",
        payload: failurePolicy[runtimeError.code],
      }),
    );
  }
  return Object.freeze(drafts);
}
