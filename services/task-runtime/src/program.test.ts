import {
  encodeRuntimeMessage,
  runtimeAbi,
  runtimeRequestSchema,
  type RuntimeFrame,
  type RuntimeRequest,
} from "@socrates/runtime-protocol";
import { describe, expect, it } from "vitest";

import type { RuntimeFrameSink, TaskRuntimeEngine } from "./engine";
import { maximumRuntimeRequestBytes, TaskRuntimeProgram } from "./program";

const buildDigest = `sha256:${"b".repeat(64)}`;

function request(): RuntimeRequest {
  return runtimeRequestSchema.parse({
    schema: "socrates.task-runtime.request.v1",
    identity: {
      runnerId: "00000000-0000-4000-8000-000000000001",
      taskId: "00000000-0000-4000-8000-000000000002",
      attemptId: "00000000-0000-4000-8000-000000000003",
      fence: 1,
    },
    source: {
      digest: `sha256:${"a".repeat(64)}`,
      path: "/socrates/source",
    },
    actions: [
      {
        executable: "/usr/bin/node",
        arguments: ["action.js"],
        workingDirectory: "/workspace",
        timeoutMs: 1_000,
      },
    ],
    measurement: {
      metricDefinitionId: "00000000-0000-4000-8000-000000000004",
      protocolRevision: 1,
      unit: "score",
      command: {
        executable: "/usr/bin/node",
        arguments: ["measure.js"],
        workingDirectory: "/workspace",
        timeoutMs: 1_000,
      },
      maximumResultBytes: 1_024,
    },
    budget: {
      wallTimeMs: 2_000,
      writableBytes: 1_024,
      outputBytes: 1_024,
      commandCount: 2,
    },
  });
}

class FakeEngine {
  requests: RuntimeRequest[] = [];

  async execute(input: RuntimeRequest, sink: RuntimeFrameSink) {
    this.requests.push(input);
    sink.write({
      type: "runtime.error",
      code: "internal_error",
      message: "test",
    });
    sink.write({ type: "runtime.completed", status: "failed" });
    return "failed" as const;
  }
}

function sink() {
  const frames: RuntimeFrame[] = [];
  return { frames, write: (frame: RuntimeFrame) => frames.push(frame) };
}

async function* chunks(bytes: Uint8Array, sizes: readonly number[]) {
  let offset = 0;
  for (const size of sizes) {
    yield bytes.subarray(offset, offset + size);
    offset += size;
  }
  if (offset < bytes.byteLength) yield bytes.subarray(offset);
}

describe("task runtime program", () => {
  it("emits exactly one embedded-identity handshake", () => {
    const output = sink();
    new TaskRuntimeProgram(
      new FakeEngine() as Pick<TaskRuntimeEngine, "execute">,
      buildDigest,
    ).handshake(output);

    expect(output.frames).toEqual([
      { type: "runtime.handshake", abi: runtimeAbi, buildDigest },
    ]);
  });

  it("decodes one canonical fragmented request before invoking the engine", async () => {
    const engine = new FakeEngine();
    const output = sink();
    const input = request();
    const encoded = encodeRuntimeMessage(
      runtimeRequestSchema,
      input,
      maximumRuntimeRequestBytes,
    );

    const status = await new TaskRuntimeProgram(
      engine as Pick<TaskRuntimeEngine, "execute">,
      buildDigest,
    ).execute(chunks(encoded, [1, 2, 7, 19]), output);

    expect(status).toBe("failed");
    expect(engine.requests).toEqual([input]);
    expect(output.frames.at(-1)).toEqual({
      type: "runtime.completed",
      status: "failed",
    });
  });

  it("invokes the engine after one complete frame without waiting for EOF", async () => {
    const engine = new FakeEngine();
    const output = sink();
    const input = request();
    const encoded = encodeRuntimeMessage(
      runtimeRequestSchema,
      input,
      maximumRuntimeRequestBytes,
    );
    let reads = 0;
    const openInput: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            reads += 1;
            if (reads === 1) return { done: false, value: encoded };
            throw new Error(
              "Runtime attempted to read past the framed request.",
            );
          },
          async return() {
            return { done: true, value: undefined };
          },
        };
      },
    };

    await new TaskRuntimeProgram(
      engine as Pick<TaskRuntimeEngine, "execute">,
      buildDigest,
    ).execute(openInput, output);

    expect(reads).toBe(1);
    expect(engine.requests).toEqual([input]);
  });

  it("rejects duplicate requests without invoking the engine", async () => {
    const engine = new FakeEngine();
    const output = sink();
    const encoded = encodeRuntimeMessage(
      runtimeRequestSchema,
      request(),
      maximumRuntimeRequestBytes,
    );
    const duplicate = new Uint8Array(encoded.byteLength * 2);
    duplicate.set(encoded);
    duplicate.set(encoded, encoded.byteLength);

    await new TaskRuntimeProgram(
      engine as Pick<TaskRuntimeEngine, "execute">,
      buildDigest,
    ).execute(chunks(duplicate, []), output);

    expect(engine.requests).toHaveLength(0);
    expect(output.frames).toEqual([
      {
        type: "runtime.error",
        code: "invalid_request",
        message: "Runtime request framing is invalid.",
      },
      { type: "runtime.completed", status: "failed" },
    ]);
  });

  it("rejects non-canonical and truncated input with the same inert error", async () => {
    const engine = new FakeEngine();
    const program = new TaskRuntimeProgram(
      engine as Pick<TaskRuntimeEngine, "execute">,
      buildDigest,
    );
    const nonCanonicalPayload = Buffer.from(
      JSON.stringify(request(), null, 2),
      "utf8",
    );
    const nonCanonical = new Uint8Array(4 + nonCanonicalPayload.byteLength);
    new DataView(nonCanonical.buffer).setUint32(
      0,
      nonCanonicalPayload.byteLength,
      false,
    );
    nonCanonical.set(nonCanonicalPayload, 4);

    for (const bytes of [nonCanonical, Uint8Array.from([0, 0, 0, 10, 123])]) {
      const output = sink();
      await program.execute(chunks(bytes, []), output);
      expect(output.frames[0]).toMatchObject({
        type: "runtime.error",
        code: "invalid_request",
      });
    }
    expect(engine.requests).toHaveLength(0);
  });
});
