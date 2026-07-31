import {
  runtimeFrameSchema,
  runtimeRequestSchema,
  type RuntimeFrame,
  type RuntimeRequest,
} from "@socrates/runtime-protocol";
import { performance } from "node:perf_hooks";

import type {
  RuntimeOutputStream,
  RuntimeProcessExecutor,
  RuntimeProcessResult,
} from "./process";
import type { RuntimeWorkspacePreparation } from "./workspace";

const maximumOutputChunkBytes = 48 * 1_024;

const runtimeEnvironment = Object.freeze({
  HOME: "/tmp",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  SOCRATES_TASK_RUNTIME: "1",
  TMPDIR: "/tmp",
});

type RuntimeCommand = RuntimeRequest["actions"][number];
type CommandAddress = Readonly<{
  phase: "action" | "measurement";
  commandIndex: number;
}>;

export interface RuntimeFrameSink {
  write(frame: RuntimeFrame): void;
}

export type TaskRuntimeEngineOptions = Readonly<{
  maximumWorkspaceEntries?: number;
  now?: () => number;
}>;

type CommandExecution = Readonly<{
  result: RuntimeProcessResult;
  stdout: Uint8Array;
}>;

export class TaskRuntimeEngine {
  readonly #workspace: RuntimeWorkspacePreparation;
  readonly #process: RuntimeProcessExecutor;
  readonly #maximumWorkspaceEntries: number;
  readonly #now: () => number;

  constructor(
    workspace: RuntimeWorkspacePreparation,
    processExecutor: RuntimeProcessExecutor,
    options: TaskRuntimeEngineOptions = {},
  ) {
    const maximumWorkspaceEntries = options.maximumWorkspaceEntries ?? 100_000;
    if (
      !Number.isSafeInteger(maximumWorkspaceEntries) ||
      maximumWorkspaceEntries < 1
    ) {
      throw new RangeError("maximumWorkspaceEntries must be positive.");
    }
    this.#workspace = workspace;
    this.#process = processExecutor;
    this.#maximumWorkspaceEntries = maximumWorkspaceEntries;
    this.#now = options.now ?? performance.now.bind(performance);
  }

  async execute(input: RuntimeRequest, sink: RuntimeFrameSink): Promise<void> {
    let request: RuntimeRequest;
    try {
      request = runtimeRequestSchema.parse(input);
    } catch {
      this.#fail(sink, "invalid_request", "Runtime request is invalid.");
      return;
    }

    const startedAt = this.#now();
    try {
      await this.#workspace.prepare({
        maximumBytes: request.budget.writableBytes,
        maximumEntries: this.#maximumWorkspaceEntries,
      });
    } catch {
      this.#fail(
        sink,
        "source_copy_failed",
        "Runtime source could not be prepared.",
      );
      return;
    }

    let remainingOutputBytes = request.budget.outputBytes;
    for (const [commandIndex, command] of request.actions.entries()) {
      const address = { phase: "action", commandIndex } as const;
      const execution = await this.#executeCommand({
        address,
        command,
        sink,
        captureStdout: false,
        maximumOutputBytes: remainingOutputBytes,
        remainingWallTimeMs: this.#remainingWallTime(
          request.budget.wallTimeMs,
          startedAt,
        ),
      });
      if (!execution) return;
      remainingOutputBytes -= execution.result.outputBytes;
      if (!this.#requireSuccess(execution.result, sink, "action")) return;
    }

    const measurementOutputLimit = Math.min(
      remainingOutputBytes,
      request.measurement.maximumResultBytes,
    );
    const measurement = await this.#executeCommand({
      address: { phase: "measurement", commandIndex: 0 },
      command: request.measurement.command,
      sink,
      captureStdout: true,
      maximumOutputBytes: measurementOutputLimit,
      remainingWallTimeMs: this.#remainingWallTime(
        request.budget.wallTimeMs,
        startedAt,
      ),
    });
    if (!measurement) return;
    if (!this.#requireSuccess(measurement.result, sink, "measurement")) return;

    this.#writeMeasurementResult(sink, measurement.stdout);
    this.#write(sink, { type: "runtime.completed", status: "succeeded" });
  }

  async #executeCommand(input: {
    address: CommandAddress;
    command: RuntimeCommand;
    sink: RuntimeFrameSink;
    captureStdout: boolean;
    maximumOutputBytes: number;
    remainingWallTimeMs: number;
  }): Promise<CommandExecution | undefined> {
    if (input.maximumOutputBytes < 1) {
      this.#fail(
        input.sink,
        "command_failed",
        "Runtime output budget is exhausted.",
      );
      return undefined;
    }
    if (input.remainingWallTimeMs < 1) {
      this.#fail(
        input.sink,
        "command_timeout",
        "Runtime wall-time budget is exhausted.",
      );
      return undefined;
    }

    this.#write(input.sink, { type: "command.started", ...input.address });
    const stdoutChunks: Uint8Array[] = [];
    let outputSequence = 0;
    const onOutput = (stream: RuntimeOutputStream, chunk: Uint8Array) => {
      if (input.captureStdout && stream === "stdout") {
        stdoutChunks.push(Uint8Array.from(chunk));
        return;
      }
      for (
        let offset = 0;
        offset < chunk.byteLength;
        offset += maximumOutputChunkBytes
      ) {
        const piece = chunk.subarray(offset, offset + maximumOutputChunkBytes);
        this.#write(input.sink, {
          type: "command.output",
          ...input.address,
          stream,
          sequence: outputSequence,
          bytes: Buffer.from(piece).toString("base64"),
        });
        outputSequence += 1;
      }
    };

    let result: RuntimeProcessResult;
    try {
      result = await this.#process.run({
        executable: input.command.executable,
        arguments: input.command.arguments,
        workingDirectory: input.command.workingDirectory,
        timeoutMs: Math.min(input.command.timeoutMs, input.remainingWallTimeMs),
        maximumOutputBytes: input.maximumOutputBytes,
        environment: runtimeEnvironment,
        onOutput,
      });
    } catch {
      this.#write(input.sink, {
        type: "command.exited",
        ...input.address,
        exitCode: null,
        signal: "SPAWN_ERROR",
        durationMs: 0,
      });
      this.#fail(
        input.sink,
        input.address.phase === "measurement"
          ? "measurement_failed"
          : "command_failed",
        "Runtime command could not be started.",
      );
      return undefined;
    }

    this.#write(input.sink, {
      type: "command.exited",
      ...input.address,
      exitCode: result.exitCode,
      signal: result.signal,
      durationMs: Math.max(0, Math.round(result.durationMs)),
    });
    return {
      result,
      stdout: Buffer.concat(stdoutChunks.map((chunk) => Buffer.from(chunk))),
    };
  }

  #requireSuccess(
    result: RuntimeProcessResult,
    sink: RuntimeFrameSink,
    phase: "action" | "measurement",
  ): boolean {
    if (result.timedOut) {
      this.#fail(sink, "command_timeout", "Runtime command timed out.");
      return false;
    }
    if (
      result.outputLimitExceeded ||
      result.exitCode !== 0 ||
      result.signal !== null
    ) {
      this.#fail(
        sink,
        phase === "measurement" ? "measurement_failed" : "command_failed",
        result.outputLimitExceeded
          ? "Runtime command exceeded its output budget."
          : "Runtime command failed.",
      );
      return false;
    }
    return true;
  }

  #remainingWallTime(budgetMs: number, startedAt: number): number {
    return Math.max(0, Math.floor(budgetMs - (this.#now() - startedAt)));
  }

  #writeMeasurementResult(sink: RuntimeFrameSink, bytes: Uint8Array): void {
    if (bytes.byteLength === 0) {
      this.#write(sink, {
        type: "measurement.result",
        sequence: 0,
        final: true,
        bytes: "",
      });
      return;
    }
    let sequence = 0;
    for (
      let offset = 0;
      offset < bytes.byteLength;
      offset += maximumOutputChunkBytes
    ) {
      const piece = bytes.subarray(offset, offset + maximumOutputChunkBytes);
      this.#write(sink, {
        type: "measurement.result",
        sequence,
        final: offset + piece.byteLength === bytes.byteLength,
        bytes: Buffer.from(piece).toString("base64"),
      });
      sequence += 1;
    }
  }

  #fail(
    sink: RuntimeFrameSink,
    code: Extract<RuntimeFrame, { type: "runtime.error" }>["code"],
    message: string,
  ): void {
    this.#write(sink, { type: "runtime.error", code, message });
    this.#write(sink, { type: "runtime.completed", status: "failed" });
  }

  #write(sink: RuntimeFrameSink, frame: RuntimeFrame): void {
    sink.write(runtimeFrameSchema.parse(frame));
  }
}
