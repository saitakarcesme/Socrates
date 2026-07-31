import {
  RuntimeMessageDecoder,
  runtimeAbi,
  runtimeFrameSchema,
  runtimeProtocolLimits,
  runtimeRequestSchema,
  type RuntimeFrame,
  type RuntimeRequest,
} from "@socrates/runtime-protocol";

import type {
  RuntimeCompletionStatus,
  RuntimeFrameSink,
  TaskRuntimeEngine,
} from "./engine";

export const maximumRuntimeRequestBytes =
  runtimeProtocolLimits.maximumRequestBytes;
export const maximumRuntimeFrameBytes = runtimeProtocolLimits.maximumFrameBytes;

export class TaskRuntimeProgram {
  readonly #engine: Pick<TaskRuntimeEngine, "execute">;
  readonly #buildDigest: string;

  constructor(engine: Pick<TaskRuntimeEngine, "execute">, buildDigest: string) {
    const parsed = runtimeFrameSchema.safeParse({
      type: "runtime.handshake",
      abi: runtimeAbi,
      buildDigest,
    });
    if (!parsed.success) {
      throw new TypeError("Runtime build digest is invalid.");
    }
    this.#engine = engine;
    this.#buildDigest = buildDigest;
  }

  handshake(sink: RuntimeFrameSink): void {
    this.#write(sink, {
      type: "runtime.handshake",
      abi: runtimeAbi,
      buildDigest: this.#buildDigest,
    });
  }

  async execute(
    input: AsyncIterable<Uint8Array>,
    sink: RuntimeFrameSink,
  ): Promise<RuntimeCompletionStatus> {
    const decoder = new RuntimeMessageDecoder(runtimeRequestSchema, {
      maximumFrameBytes: maximumRuntimeRequestBytes,
      maximumAggregateBytes: maximumRuntimeRequestBytes + 4,
      maximumFrames: 1,
    });
    let request: RuntimeRequest | undefined;
    try {
      for await (const chunk of input) {
        const messages = decoder.push(chunk);
        if (messages.length === 1) {
          request = messages[0];
          decoder.finish();
          break;
        }
      }
      if (!request) {
        decoder.finish();
        throw new Error("Runtime request is missing.");
      }
    } catch {
      this.#write(sink, {
        type: "runtime.error",
        code: "invalid_request",
        message: "Runtime request framing is invalid.",
      });
      this.#write(sink, { type: "runtime.completed", status: "failed" });
      return "failed";
    }
    return this.#engine.execute(request, sink);
  }

  #write(sink: RuntimeFrameSink, frame: RuntimeFrame): void {
    sink.write(runtimeFrameSchema.parse(frame));
  }
}
