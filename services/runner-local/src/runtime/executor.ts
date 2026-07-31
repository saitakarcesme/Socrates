import {
  RuntimeFrameSequenceValidator,
  RuntimeMessageDecoder,
  encodeRuntimeMessage,
  runtimeFrameSchema,
  runtimeProtocolLimits,
  runtimeRequestSchema,
  type RuntimeFrame,
  type RuntimeRequest,
} from "@socrates/runtime-protocol";

import type { AdmittedSandboxImage } from "../image/capability";
import type {
  SandboxExecutionResult,
  SandboxRuntimeExecution,
} from "../oci/backend";
import type { SandboxResourceProfile } from "../oci/profile";
import type { MaterializedSourceSnapshot } from "../source/capability";

export interface RuntimeSandboxBackend {
  executeRuntime(
    input: SandboxRuntimeExecution,
  ): Promise<SandboxExecutionResult>;
}

export type RuntimeSandboxExecutorOptions = Readonly<{
  maximumProtocolBytes: number;
  maximumChildOutputBytes: number;
}>;

export type RuntimeSandboxResult = Readonly<{
  status: "failed" | "succeeded";
  frames: readonly RuntimeFrame[];
  durationMs: number;
}>;

export class RuntimeSandboxError extends Error {
  constructor(
    readonly code: "invalid_request" | "protocol" | "runtime_mismatch",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RuntimeSandboxError";
  }
}

function positiveLimit(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
}

export class RuntimeSandboxExecutor {
  readonly #maximumProtocolBytes: number;
  readonly #maximumChildOutputBytes: number;

  constructor(
    readonly backend: RuntimeSandboxBackend,
    options: RuntimeSandboxExecutorOptions,
  ) {
    positiveLimit("maximumProtocolBytes", options.maximumProtocolBytes);
    positiveLimit("maximumChildOutputBytes", options.maximumChildOutputBytes);
    if (
      options.maximumProtocolBytes <
      runtimeProtocolLimits.maximumFrameBytes + 4
    ) {
      throw new RangeError(
        "maximumProtocolBytes cannot hold one runtime frame.",
      );
    }
    this.#maximumProtocolBytes = options.maximumProtocolBytes;
    this.#maximumChildOutputBytes = options.maximumChildOutputBytes;
  }

  async execute(input: {
    request: RuntimeRequest;
    image: AdmittedSandboxImage;
    profile: SandboxResourceProfile;
    source: MaterializedSourceSnapshot;
    signal?: AbortSignal;
  }): Promise<RuntimeSandboxResult> {
    const parsed = runtimeRequestSchema.safeParse(input.request);
    if (!parsed.success) {
      throw new RuntimeSandboxError(
        "invalid_request",
        "Runtime request is invalid.",
      );
    }
    const request = parsed.data;
    if (
      request.source.digest !== input.source.digest ||
      request.budget.writableBytes > input.profile.workspaceBytes ||
      request.budget.outputBytes > this.#maximumChildOutputBytes
    ) {
      throw new RuntimeSandboxError(
        "invalid_request",
        "Runtime request exceeds its bound source or runner policy.",
      );
    }
    let stdin: Uint8Array;
    try {
      stdin = encodeRuntimeMessage(
        runtimeRequestSchema,
        request,
        runtimeProtocolLimits.maximumRequestBytes,
      );
    } catch (cause) {
      throw new RuntimeSandboxError(
        "invalid_request",
        "Runtime request cannot be encoded within its protocol bound.",
        { cause },
      );
    }

    const result = await this.backend.executeRuntime({
      identity: request.identity,
      image: input.image,
      profile: input.profile,
      source: { snapshot: input.source, expectedDigest: request.source.digest },
      signal: input.signal,
      stdin,
      maximumInputBytes: runtimeProtocolLimits.maximumRequestBytes + 4,
    });
    if (result.stderr !== "" || result.stderrBytes.byteLength !== 0) {
      throw new RuntimeSandboxError(
        "protocol",
        "Task runtime wrote outside its framed stdout channel.",
      );
    }

    let frames: readonly RuntimeFrame[];
    try {
      const decoder = new RuntimeMessageDecoder(runtimeFrameSchema, {
        maximumFrameBytes: runtimeProtocolLimits.maximumFrameBytes,
        maximumAggregateBytes: this.#maximumProtocolBytes,
        maximumFrames: runtimeProtocolLimits.maximumExecutionFrames,
      });
      const decoded = decoder.push(result.stdoutBytes);
      decoder.finish();
      const sequence = new RuntimeFrameSequenceValidator({
        mode: "execution",
        actionCount: request.actions.length,
      });
      for (const frame of decoded) sequence.accept(frame);
      sequence.finish();
      frames = Object.freeze([...decoded]);
    } catch (cause) {
      throw new RuntimeSandboxError(
        "protocol",
        "Task runtime returned an invalid frame stream.",
        { cause },
      );
    }
    const terminal = frames.at(-1);
    if (terminal?.type !== "runtime.completed") {
      throw new RuntimeSandboxError(
        "protocol",
        "Task runtime did not return a terminal frame.",
      );
    }
    const exitMatches =
      (terminal.status === "succeeded" && result.exitCode === 0) ||
      (terminal.status === "failed" && result.exitCode === 1);
    if (!exitMatches) {
      throw new RuntimeSandboxError(
        "runtime_mismatch",
        "Task runtime exit code contradicts its terminal frame.",
      );
    }
    return Object.freeze({
      status: terminal.status,
      frames,
      durationMs: result.durationMs,
    });
  }
}
