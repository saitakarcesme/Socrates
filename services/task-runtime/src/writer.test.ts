import {
  RuntimeMessageDecoder,
  runtimeFrameSchema,
  type RuntimeFrame,
} from "@socrates/runtime-protocol";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { maximumRuntimeFrameBytes } from "./program";
import { NodeRuntimeFrameWriter } from "./writer";

describe("runtime frame writer", () => {
  it("serializes canonical frames in order through a backpressure-aware stream", async () => {
    const output = new PassThrough({ highWaterMark: 1 });
    const bytes: Buffer[] = [];
    output.on("data", (chunk: Buffer) => bytes.push(Buffer.from(chunk)));
    const writer = new NodeRuntimeFrameWriter(output);
    writer.write({
      type: "runtime.error",
      code: "internal_error",
      message: "bounded",
    });
    writer.write({ type: "runtime.completed", status: "failed" });

    await writer.finish();
    const decoder = new RuntimeMessageDecoder(runtimeFrameSchema, {
      maximumFrameBytes: maximumRuntimeFrameBytes,
      maximumAggregateBytes: 2 * maximumRuntimeFrameBytes,
      maximumFrames: 2,
    });
    const frames: RuntimeFrame[] = [];
    frames.push(...decoder.push(Buffer.concat(bytes)));
    decoder.finish();
    expect(frames).toEqual([
      {
        type: "runtime.error",
        code: "internal_error",
        message: "bounded",
      },
      { type: "runtime.completed", status: "failed" },
    ]);
  });
});
