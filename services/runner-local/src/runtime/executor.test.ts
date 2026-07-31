import {
  RuntimeMessageDecoder,
  encodeRuntimeMessage,
  runtimeFrameSchema,
  runtimeProtocolLimits,
  runtimeRequestSchema,
  type RuntimeFrame,
  type RuntimeRequest,
} from "@socrates/runtime-protocol";
import { describe, expect, it } from "vitest";

import { RuntimeSandboxError, RuntimeSandboxExecutor } from "./executor";
import {
  fixtureIdentity,
  fixtureImage,
  fixtureProfile,
} from "../oci/test-fixtures";
import { issueMaterializedSourceSnapshot } from "../source/capability";

import type {
  SandboxExecutionResult,
  SandboxRuntimeExecution,
} from "../oci/backend";
import type { RuntimeSandboxBackend } from "./executor";

const sourceDigest = `sha256:${"a".repeat(64)}`;
const source = issueMaterializedSourceSnapshot({
  path: "/runner/sources/runtime/tree",
  deploymentId: "test-deployment",
  identity: fixtureIdentity,
  digest: sourceDigest,
  archiveBytes: 128,
  expandedBytes: 64,
  entryCount: 1,
});

function request(): RuntimeRequest {
  return runtimeRequestSchema.parse({
    schema: "socrates.task-runtime.request.v1",
    identity: fixtureIdentity,
    source: { digest: sourceDigest, path: "/socrates/source" },
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
      writableBytes: fixtureProfile.workspaceBytes,
      outputBytes: 128 * 1_024,
      commandCount: 2,
    },
  });
}

function successfulFrames(): RuntimeFrame[] {
  return [
    { type: "command.started", phase: "action", commandIndex: 0 },
    {
      type: "command.exited",
      phase: "action",
      commandIndex: 0,
      exitCode: 0,
      signal: null,
      durationMs: 1,
    },
    { type: "command.started", phase: "measurement", commandIndex: 0 },
    {
      type: "command.exited",
      phase: "measurement",
      commandIndex: 0,
      exitCode: 0,
      signal: null,
      durationMs: 1,
    },
    {
      type: "measurement.result",
      sequence: 0,
      final: true,
      bytes: "MQ==",
    },
    { type: "runtime.completed", status: "succeeded" },
  ];
}

function framed(frames: RuntimeFrame[]): Uint8Array {
  const messages = frames.map((frame) =>
    encodeRuntimeMessage(
      runtimeFrameSchema,
      frame,
      runtimeProtocolLimits.maximumFrameBytes,
    ),
  );
  const output = new Uint8Array(
    messages.reduce((total, message) => total + message.byteLength, 0),
  );
  let offset = 0;
  for (const message of messages) {
    output.set(message, offset);
    offset += message.byteLength;
  }
  return output;
}

class FakeBackend implements RuntimeSandboxBackend {
  calls: SandboxRuntimeExecution[] = [];

  constructor(readonly result: SandboxExecutionResult) {}

  async executeRuntime(input: SandboxRuntimeExecution) {
    this.calls.push(input);
    return this.result;
  }
}

function outcome(
  stdoutBytes: Uint8Array,
  overrides: Partial<SandboxExecutionResult> = {},
): SandboxExecutionResult {
  return {
    exitCode: 0,
    stdout: "",
    stderr: "",
    stdoutBytes,
    stderrBytes: new Uint8Array(),
    durationMs: 7,
    ...overrides,
  };
}

function executor(backend: RuntimeSandboxBackend) {
  return new RuntimeSandboxExecutor(backend, {
    maximumProtocolBytes: 512 * 1_024,
    maximumChildOutputBytes: 256 * 1_024,
  });
}

describe("runtime sandbox executor", () => {
  it("sends one canonical request over stdin and validates the response sequence", async () => {
    const backend = new FakeBackend(outcome(framed(successfulFrames())));
    const input = request();

    await expect(
      executor(backend).execute({
        request: input,
        image: fixtureImage,
        profile: fixtureProfile,
        source,
      }),
    ).resolves.toMatchObject({
      status: "succeeded",
      durationMs: 7,
      frames: successfulFrames(),
    });

    expect(backend.calls).toHaveLength(1);
    expect(backend.calls[0]?.image.runtime).toEqual(fixtureImage.runtime);
    expect(backend.calls[0]?.maximumInputBytes).toBe(
      runtimeProtocolLimits.maximumRequestBytes + 4,
    );
    const decoder = new RuntimeMessageDecoder(runtimeRequestSchema, {
      maximumFrameBytes: runtimeProtocolLimits.maximumRequestBytes,
      maximumAggregateBytes: runtimeProtocolLimits.maximumRequestBytes + 4,
      maximumFrames: 1,
    });
    expect(decoder.push(backend.calls[0]?.stdin ?? new Uint8Array())).toEqual([
      input,
    ]);
    expect(() => decoder.finish()).not.toThrow();
  });

  it.each([
    [
      "source digest",
      (input: RuntimeRequest) => ({
        ...input,
        source: { ...input.source, digest: `sha256:${"f".repeat(64)}` },
      }),
    ],
    [
      "workspace budget",
      (input: RuntimeRequest) => ({
        ...input,
        budget: {
          ...input.budget,
          writableBytes: fixtureProfile.workspaceBytes + 1,
        },
      }),
    ],
    [
      "output policy",
      (input: RuntimeRequest) => ({
        ...input,
        budget: { ...input.budget, outputBytes: 256 * 1_024 + 1 },
      }),
    ],
  ])("rejects %s mismatch before backend execution", async (_name, mutate) => {
    const backend = new FakeBackend(outcome(framed(successfulFrames())));
    await expect(
      executor(backend).execute({
        request: mutate(request()),
        image: fixtureImage,
        profile: fixtureProfile,
        source,
      }),
    ).rejects.toMatchObject<Partial<RuntimeSandboxError>>({
      code: "invalid_request",
    });
    expect(backend.calls).toHaveLength(0);
  });

  it.each([
    ["invalid UTF-8", outcome(Uint8Array.from([0, 0, 0, 2, 0xc3, 0x28]))],
    [
      "stderr",
      outcome(framed(successfulFrames()), {
        stderr: "noise",
        stderrBytes: Uint8Array.from(Buffer.from("noise")),
      }),
    ],
    [
      "handshake injection",
      outcome(
        framed([
          {
            type: "runtime.handshake",
            abi: "socrates.task-runtime.v1",
            buildDigest: `sha256:${"b".repeat(64)}`,
          },
        ]),
      ),
    ],
  ])("rejects %s in runtime output", async (_name, result) => {
    await expect(
      executor(new FakeBackend(result)).execute({
        request: request(),
        image: fixtureImage,
        profile: fixtureProfile,
        source,
      }),
    ).rejects.toMatchObject<Partial<RuntimeSandboxError>>({ code: "protocol" });
  });

  it("rejects an exit code that contradicts the terminal frame", async () => {
    await expect(
      executor(
        new FakeBackend(outcome(framed(successfulFrames()), { exitCode: 1 })),
      ).execute({
        request: request(),
        image: fixtureImage,
        profile: fixtureProfile,
        source,
      }),
    ).rejects.toMatchObject<Partial<RuntimeSandboxError>>({
      code: "runtime_mismatch",
    });
  });
});
