import {
  RuntimeFrameSequenceValidator,
  RuntimeMessageDecoder,
  runtimeFrameSchema,
} from "@socrates/runtime-protocol";
import { randomUUID } from "node:crypto";

import type { InspectedSandboxImage } from "./capability";
import type { SandboxImageHandshakeVerifier } from "./catalog";
import type {
  SandboxExecutionResult,
  SandboxImageProbeExecution,
} from "../oci/backend";
import type { SandboxCommand, SandboxResourceProfile } from "../oci/profile";

export interface InspectedImageExecutor {
  executeInspectedImage(
    input: SandboxImageProbeExecution,
  ): Promise<SandboxExecutionResult>;
}

export type NerdctlImageHandshakeVerifierOptions = Readonly<{
  runnerId: string;
  profile: SandboxResourceProfile;
  maximumFrameBytes?: number;
}>;

export class NerdctlImageHandshakeVerifier implements SandboxImageHandshakeVerifier {
  readonly #runnerId: string;
  readonly #profile: SandboxResourceProfile;
  readonly #maximumFrameBytes: number;

  constructor(
    readonly backend: InspectedImageExecutor,
    options: NerdctlImageHandshakeVerifierOptions,
  ) {
    if (!options.runnerId.trim())
      throw new TypeError("runnerId cannot be empty.");
    this.#runnerId = options.runnerId;
    this.#profile = Object.freeze({ ...options.profile });
    this.#maximumFrameBytes = options.maximumFrameBytes ?? 16 * 1_024;
    if (
      !Number.isSafeInteger(this.#maximumFrameBytes) ||
      this.#maximumFrameBytes < 1
    ) {
      throw new RangeError("maximumFrameBytes must be positive.");
    }
  }

  async verify(input: {
    image: InspectedSandboxImage;
    runtime: SandboxCommand;
  }): Promise<Readonly<{ abi: string; buildDigest: string }>> {
    const result = await this.backend.executeInspectedImage({
      identity: {
        runnerId: this.#runnerId,
        taskId: randomUUID(),
        attemptId: randomUUID(),
        fence: 1,
      },
      image: input.image,
      profile: this.#profile,
      command: input.runtime,
    });
    if (
      result.exitCode !== 0 ||
      result.stderrBytes.byteLength !== 0 ||
      result.stderr !== ""
    ) {
      throw new Error("Runtime handshake process did not exit cleanly.");
    }
    const decoder = new RuntimeMessageDecoder(runtimeFrameSchema, {
      maximumFrameBytes: this.#maximumFrameBytes,
      maximumAggregateBytes: this.#maximumFrameBytes + 4,
      maximumFrames: 1,
    });
    const frames = decoder.push(result.stdoutBytes);
    decoder.finish();
    if (frames.length !== 1 || frames[0]?.type !== "runtime.handshake") {
      throw new Error("Runtime handshake output is invalid.");
    }
    const sequence = new RuntimeFrameSequenceValidator({ mode: "handshake" });
    sequence.accept(frames[0]);
    sequence.finish();
    return Object.freeze({
      abi: frames[0].abi,
      buildDigest: frames[0].buildDigest,
    });
  }
}
