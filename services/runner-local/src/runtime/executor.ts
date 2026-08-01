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
import { createHash } from "node:crypto";

import type { AdmittedSandboxImage } from "../image/capability";
import type {
  SandboxExecutionResult,
  SandboxRuntimeExecution,
} from "../oci/backend";
import { SandboxBackendError } from "../oci/backend";
import type { SandboxResourceProfile } from "../oci/profile";
import type { MaterializedSourceSnapshot } from "../source/capability";
import type { MaterializedRuntimeRequest } from "../request/capability";

export interface RuntimeSandboxBackend {
  executeRuntime(
    input: SandboxRuntimeExecution,
  ): Promise<SandboxExecutionResult>;
}

export interface RuntimeRequestMaterializerPort {
  materialize(input: {
    bytes: Uint8Array;
    identity: RuntimeRequest["identity"];
    source: MaterializedSourceSnapshot;
  }): Promise<MaterializedRuntimeRequest>;
  release(capability: MaterializedRuntimeRequest): Promise<void>;
}

export interface RuntimeExecutionStartBarrier {
  cross(): Promise<void>;
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
    readonly code:
      | "invalid_request"
      | "protocol"
      | "cancelled"
      | "cleanup_failed"
      | "request_release_failed"
      | "request_materialization_failed"
      | "sandbox_backend_failed"
      | "runtime_mismatch",
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

function cancellation(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new RuntimeSandboxError(
    "cancelled",
    "Runtime sandbox execution was explicitly cancelled.",
    { cause: signal.reason },
  );
}

function backendFailure(cause: unknown): RuntimeSandboxError {
  if (cause instanceof SandboxBackendError && cause.code === "aborted") {
    return new RuntimeSandboxError(
      "cancelled",
      "Runtime sandbox execution was explicitly cancelled.",
      { cause },
    );
  }
  if (cause instanceof SandboxBackendError && cause.code === "cleanup") {
    return new RuntimeSandboxError(
      "cleanup_failed",
      "Sandbox cleanup could not be proven.",
      { cause },
    );
  }
  return new RuntimeSandboxError(
    "sandbox_backend_failed",
    "The sandbox backend failed to execute the runtime request.",
    { cause },
  );
}

export class RuntimeSandboxExecutor {
  readonly #maximumProtocolBytes: number;
  readonly #maximumChildOutputBytes: number;

  constructor(
    readonly backend: RuntimeSandboxBackend,
    readonly requests: RuntimeRequestMaterializerPort,
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
    startBarrier: RuntimeExecutionStartBarrier;
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
    let encodedRequest: Uint8Array;
    try {
      encodedRequest = encodeRuntimeMessage(
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

    cancellation(input.signal);
    let envelope: MaterializedRuntimeRequest;
    try {
      envelope = await this.requests.materialize({
        bytes: encodedRequest,
        identity: request.identity,
        source: input.source,
      });
    } catch (cause) {
      if (input.signal?.aborted && cause === input.signal.reason) {
        cancellation(input.signal);
      }
      throw new RuntimeSandboxError(
        "request_materialization_failed",
        "The bounded runtime request could not be materialized.",
        { cause },
      );
    }
    const expectedRequestDigest = `sha256:${createHash("sha256")
      .update(encodedRequest)
      .digest("hex")}`;
    let executionOutcome:
      | Readonly<{ state: "failed"; cause: unknown }>
      | Readonly<{ state: "succeeded"; result: SandboxExecutionResult }>;
    try {
      cancellation(input.signal);
      await input.startBarrier.cross();
      try {
        const execution = this.backend.executeRuntime({
          identity: request.identity,
          image: input.image,
          profile: input.profile,
          source: {
            snapshot: input.source,
            expectedDigest: request.source.digest,
          },
          request: { envelope, expectedDigest: expectedRequestDigest },
          signal: input.signal,
        });
        executionOutcome = { state: "succeeded", result: await execution };
      } catch (cause) {
        throw backendFailure(cause);
      }
    } catch (cause) {
      executionOutcome = { state: "failed", cause };
    }
    try {
      await this.requests.release(envelope);
    } catch (releaseFailure) {
      throw new RuntimeSandboxError(
        "request_release_failed",
        "The materialized runtime request could not be released.",
        {
          cause:
            executionOutcome.state === "succeeded"
              ? releaseFailure
              : new AggregateError([executionOutcome.cause, releaseFailure]),
        },
      );
    }
    if (executionOutcome.state === "failed") throw executionOutcome.cause;
    const { result } = executionOutcome;
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
