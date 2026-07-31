import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  encodeRuntimeMessage,
  RuntimeMessageDecoder,
  RuntimeProtocolError,
} from "./framing";
import {
  runtimeFrameSchema,
  runtimeRequestSchema,
  runtimeRequestSchemaName,
  type RuntimeFrame,
} from "./schema";

const limits = {
  maximumFrameBytes: 128 * 1_024,
  maximumAggregateBytes: 512 * 1_024,
  maximumFrames: 128,
} as const;

function framed(payload: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(4 + payload.byteLength);
  new DataView(bytes.buffer).setUint32(0, payload.byteLength, false);
  bytes.set(payload, 4);
  return bytes;
}

describe("runtime protocol framing", () => {
  it("round-trips canonical frames across arbitrary fragmentation", () => {
    const frame: RuntimeFrame = {
      type: "command.output",
      phase: "action",
      commandIndex: 0,
      stream: "stdout",
      sequence: 0,
      bytes: "AAEC/w==",
    };
    const encoded = encodeRuntimeMessage(
      runtimeFrameSchema,
      frame,
      limits.maximumFrameBytes,
    );

    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 17 }), {
          minLength: 1,
          maxLength: 32,
        }),
        (sizes) => {
          const decoder = new RuntimeMessageDecoder(runtimeFrameSchema, limits);
          const observed: RuntimeFrame[] = [];
          let offset = 0;
          for (const size of sizes) {
            if (offset >= encoded.byteLength) break;
            observed.push(
              ...decoder.push(encoded.subarray(offset, offset + size)),
            );
            offset += size;
          }
          if (offset < encoded.byteLength) {
            observed.push(...decoder.push(encoded.subarray(offset)));
          }
          decoder.finish();
          expect(observed).toEqual([frame]);
        },
      ),
      { numRuns: 250 },
    );
  });

  it("rejects valid but non-canonical JSON", () => {
    const payload = new TextEncoder().encode(
      '{"type":"runtime.completed", "status":"succeeded"}',
    );
    const decoder = new RuntimeMessageDecoder(runtimeFrameSchema, limits);

    expect(() => decoder.push(framed(payload))).toThrowError(
      expect.objectContaining<Partial<RuntimeProtocolError>>({
        code: "non_canonical",
      }),
    );
  });

  it("rejects invalid UTF-8 and truncated frames", () => {
    const invalidUtf8 = new RuntimeMessageDecoder(runtimeFrameSchema, limits);
    expect(() =>
      invalidUtf8.push(framed(new Uint8Array([0xc3, 0x28]))),
    ).toThrowError(
      expect.objectContaining<Partial<RuntimeProtocolError>>({
        code: "invalid_utf8",
      }),
    );

    const truncated = new RuntimeMessageDecoder(runtimeFrameSchema, limits);
    truncated.push(new Uint8Array([0, 0, 0, 10, 1, 2]));
    expect(() => truncated.finish()).toThrowError(
      expect.objectContaining<Partial<RuntimeProtocolError>>({
        code: "truncated",
      }),
    );
  });

  it("bounds individual, aggregate, and frame counts", () => {
    const terminal = encodeRuntimeMessage(
      runtimeFrameSchema,
      { type: "runtime.completed", status: "succeeded" },
      limits.maximumFrameBytes,
    );
    const frameLimited = new RuntimeMessageDecoder(runtimeFrameSchema, {
      maximumFrameBytes: 1_024,
      maximumAggregateBytes: 4_096,
      maximumFrames: 1,
    });
    frameLimited.push(terminal);
    expect(() => frameLimited.push(terminal)).toThrowError(
      expect.objectContaining<Partial<RuntimeProtocolError>>({
        code: "frame_limit",
      }),
    );

    const aggregateLimited = new RuntimeMessageDecoder(runtimeFrameSchema, {
      maximumFrameBytes: 64,
      maximumAggregateBytes: 64,
      maximumFrames: 1,
    });
    expect(() => aggregateLimited.push(new Uint8Array(65))).toThrowError(
      expect.objectContaining<Partial<RuntimeProtocolError>>({
        code: "aggregate_limit",
      }),
    );
  });
});

describe("runtime request schema", () => {
  const command = {
    executable: "/usr/local/bin/node",
    arguments: ["--version"],
    workingDirectory: "/workspace",
    timeoutMs: 1_000,
  } as const;
  const request = {
    schema: runtimeRequestSchemaName,
    identity: {
      runnerId: "10000000-0000-4000-8000-000000000001",
      taskId: "20000000-0000-4000-8000-000000000002",
      attemptId: "30000000-0000-4000-8000-000000000003",
      fence: 1,
    },
    source: {
      digest: `sha256:${"a".repeat(64)}`,
      path: "/socrates/source",
    },
    actions: [command],
    measurement: {
      metricDefinitionId: "40000000-0000-4000-8000-000000000004",
      protocolRevision: 1,
      unit: "ms",
      command,
      maximumResultBytes: 1_024,
    },
    budget: {
      wallTimeMs: 5_000,
      writableBytes: 1_048_576,
      outputBytes: 64 * 1_024,
      commandCount: 2,
    },
  } as const;

  it("admits a closed request and canonical encoding", () => {
    expect(runtimeRequestSchema.parse(request)).toEqual(request);
    expect(
      encodeRuntimeMessage(runtimeRequestSchema, request, 256 * 1_024),
    ).toBeInstanceOf(Uint8Array);
  });

  it("rejects command and wall-time budget violations", () => {
    expect(() =>
      runtimeRequestSchema.parse({
        ...request,
        budget: { ...request.budget, commandCount: 1 },
      }),
    ).toThrow();
    expect(() =>
      runtimeRequestSchema.parse({
        ...request,
        actions: [{ ...command, timeoutMs: 5_001 }],
      }),
    ).toThrow();
  });
});
