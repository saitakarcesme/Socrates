import {
  RuntimeMessageDecoder,
  encodeRuntimeMessage,
  runtimeFrameSchema,
  runtimeProtocolLimits,
  runtimeRequestSchema,
  type RuntimeFrame,
  type RuntimeRequest,
} from "@socrates/runtime-protocol";
import { describe, expect, it, vi } from "vitest";

import { RuntimeSandboxError, RuntimeSandboxExecutor } from "./executor";
import {
  fixtureIdentity,
  fixtureImage,
  fixtureProfile,
} from "../oci/test-fixtures";
import { issueMaterializedSourceSnapshot } from "../source/capability";
import { issueMaterializedRuntimeRequest } from "../request/capability";
import { SandboxBackendError } from "../oci/backend";

import type {
  SandboxExecutionResult,
  SandboxRuntimeExecution,
} from "../oci/backend";
import type { RuntimeSandboxBackend } from "./executor";
import type { RuntimeRequestMaterializerPort } from "./executor";

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

class FakeRequestMaterializer implements RuntimeRequestMaterializerPort {
  bytes: Uint8Array[] = [];
  releases = 0;

  async materialize(
    input: Parameters<RuntimeRequestMaterializerPort["materialize"]>[0],
  ) {
    this.bytes.push(input.bytes);
    return issueMaterializedRuntimeRequest({
      path: "/runner/sources/runtime/request.bin",
      deploymentId: "test-deployment",
      identity: input.identity,
      digest: `sha256:${"b".repeat(64)}`,
      sizeBytes: input.bytes.byteLength,
    });
  }

  async release() {
    this.releases += 1;
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

function executor(
  backend: RuntimeSandboxBackend,
  requests = new FakeRequestMaterializer(),
) {
  return new RuntimeSandboxExecutor(backend, requests, {
    maximumProtocolBytes: 512 * 1_024,
    maximumChildOutputBytes: 256 * 1_024,
  });
}

function startBarrier(cross = vi.fn(async () => undefined)) {
  return { cross };
}

describe("runtime sandbox executor", () => {
  it("materializes one canonical request and validates the response sequence", async () => {
    const backend = new FakeBackend(outcome(framed(successfulFrames())));
    const materialized = new FakeRequestMaterializer();
    const input = request();

    await expect(
      executor(backend, materialized).execute({
        request: input,
        image: fixtureImage,
        profile: fixtureProfile,
        source,
        startBarrier: startBarrier(),
      }),
    ).resolves.toMatchObject({
      status: "succeeded",
      durationMs: 7,
      frames: successfulFrames(),
    });

    expect(backend.calls).toHaveLength(1);
    expect(backend.calls[0]?.image.runtime).toEqual(fixtureImage.runtime);
    expect(backend.calls[0]?.request?.envelope).toBeDefined();
    expect(materialized.releases).toBe(1);
    const decoder = new RuntimeMessageDecoder(runtimeRequestSchema, {
      maximumFrameBytes: runtimeProtocolLimits.maximumRequestBytes,
      maximumAggregateBytes: runtimeProtocolLimits.maximumRequestBytes + 4,
      maximumFrames: 1,
    });
    expect(decoder.push(materialized.bytes[0] ?? new Uint8Array())).toEqual([
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
        startBarrier: startBarrier(),
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
        startBarrier: startBarrier(),
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
        startBarrier: startBarrier(),
      }),
    ).rejects.toMatchObject<Partial<RuntimeSandboxError>>({
      code: "runtime_mismatch",
    });
  });

  it("crosses after request materialization and immediately invokes the backend", async () => {
    const order: string[] = [];
    const requests: RuntimeRequestMaterializerPort = {
      materialize: async (input) => {
        order.push("materialize");
        return issueMaterializedRuntimeRequest({
          path: "/runner/sources/runtime/request-order.bin",
          deploymentId: "test-deployment",
          identity: input.identity,
          digest: `sha256:${"c".repeat(64)}`,
          sizeBytes: input.bytes.byteLength,
        });
      },
      release: async () => {
        order.push("release");
      },
    };
    const backend: RuntimeSandboxBackend = {
      executeRuntime: () => {
        order.push("backend");
        return Promise.resolve(outcome(framed(successfulFrames())));
      },
    };

    await executor(backend, requests).execute({
      request: request(),
      image: fixtureImage,
      profile: fixtureProfile,
      source,
      startBarrier: startBarrier(
        vi.fn(async () => {
          order.push("barrier");
        }),
      ),
    });
    expect(order).toEqual(["materialize", "barrier", "backend", "release"]);
  });

  it("does not materialize, cross, or invoke the backend when already cancelled", async () => {
    const backend = new FakeBackend(outcome(framed(successfulFrames())));
    const requests = new FakeRequestMaterializer();
    const cross = vi.fn(async () => undefined);
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));

    await expect(
      executor(backend, requests).execute({
        request: request(),
        image: fixtureImage,
        profile: fixtureProfile,
        source,
        startBarrier: startBarrier(cross),
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancelled");
    expect(requests.bytes).toHaveLength(0);
    expect(cross).not.toHaveBeenCalled();
    expect(backend.calls).toHaveLength(0);
  });

  it("normalizes request materialization without erasing unrelated failure", async () => {
    const backend = new FakeBackend(outcome(framed(successfulFrames())));
    const requests = new FakeRequestMaterializer();
    const failure = new Error("private materializer detail");
    const controller = new AbortController();
    requests.materialize = async () => {
      controller.abort(new Error("late cancellation"));
      throw failure;
    };

    await expect(
      executor(backend, requests).execute({
        request: request(),
        image: fixtureImage,
        profile: fixtureProfile,
        source,
        startBarrier: startBarrier(),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({
      code: "request_materialization_failed",
      cause: failure,
    });
    expect(requests.releases).toBe(0);
    expect(backend.calls).toHaveLength(0);
  });

  it("recognizes exact request materializer abort reason", async () => {
    const backend = new FakeBackend(outcome(framed(successfulFrames())));
    const requests = new FakeRequestMaterializer();
    const reason = new Error("lease revoked");
    const controller = new AbortController();
    requests.materialize = async () => {
      controller.abort(reason);
      throw reason;
    };

    await expect(
      executor(backend, requests).execute({
        request: request(),
        image: fixtureImage,
        profile: fixtureProfile,
        source,
        startBarrier: startBarrier(),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "cancelled", cause: reason });
  });

  it("releases a materialized request without crossing when cancellation races", async () => {
    const backend = new FakeBackend(outcome(framed(successfulFrames())));
    const requests = new FakeRequestMaterializer();
    const cross = vi.fn(async () => undefined);
    const controller = new AbortController();
    const cancellationReason = new Error("cancelled during materialization");
    const materialize = requests.materialize.bind(requests);
    requests.materialize = async (input) => {
      const capability = await materialize(input);
      controller.abort(cancellationReason);
      return capability;
    };

    const operation = executor(backend, requests).execute({
      request: request(),
      image: fixtureImage,
      profile: fixtureProfile,
      source,
      startBarrier: startBarrier(cross),
      signal: controller.signal,
    });
    await expect(operation).rejects.toMatchObject({
      code: "cancelled",
      cause: cancellationReason,
    });
    expect(requests.releases).toBe(1);
    expect(cross).not.toHaveBeenCalled();
    expect(backend.calls).toHaveLength(0);
  });

  it("releases the request and never invokes the backend when crossing fails", async () => {
    const backend = new FakeBackend(outcome(framed(successfulFrames())));
    const requests = new FakeRequestMaterializer();
    const failure = new Error("journal uncertain");

    await expect(
      executor(backend, requests).execute({
        request: request(),
        image: fixtureImage,
        profile: fixtureProfile,
        source,
        startBarrier: startBarrier(vi.fn(async () => Promise.reject(failure))),
      }),
    ).rejects.toBe(failure);
    expect(requests.releases).toBe(1);
    expect(backend.calls).toHaveLength(0);
  });

  it("releases the request after a synchronous backend failure", async () => {
    const failure = new Error("backend invocation failed");
    const requests = new FakeRequestMaterializer();
    const cross = vi.fn(async () => undefined);
    const backend: RuntimeSandboxBackend = {
      executeRuntime: () => {
        throw failure;
      },
    };

    await expect(
      executor(backend, requests).execute({
        request: request(),
        image: fixtureImage,
        profile: fixtureProfile,
        source,
        startBarrier: startBarrier(cross),
      }),
    ).rejects.toMatchObject({
      code: "sandbox_backend_failed",
      cause: failure,
    });
    expect(cross).toHaveBeenCalledOnce();
    expect(requests.releases).toBe(1);
  });

  it("classifies release failure without exposing adapter text", async () => {
    const releaseFailure = new Error("secret request path");
    const requests = new FakeRequestMaterializer();
    requests.release = async () => Promise.reject(releaseFailure);

    const operation = executor(
      new FakeBackend(outcome(framed(successfulFrames()))),
      requests,
    ).execute({
      request: request(),
      image: fixtureImage,
      profile: fixtureProfile,
      source,
      startBarrier: startBarrier(),
    });
    await expect(operation).rejects.toMatchObject<Partial<RuntimeSandboxError>>(
      {
        code: "request_release_failed",
        message: "The materialized runtime request could not be released.",
        cause: releaseFailure,
      },
    );
    await expect(operation).rejects.not.toThrow("secret request path");
  });

  it("distinguishes sandbox cleanup uncertainty from backend failure", async () => {
    const cleanup = new SandboxBackendError(
      "cleanup",
      "private cleanup detail",
    );
    const backend: RuntimeSandboxBackend = {
      executeRuntime: async () => Promise.reject(cleanup),
    };

    await expect(
      executor(backend, new FakeRequestMaterializer()).execute({
        request: request(),
        image: fixtureImage,
        profile: fixtureProfile,
        source,
        startBarrier: startBarrier(),
      }),
    ).rejects.toMatchObject({
      code: "cleanup_failed",
      cause: cleanup,
      message: "Sandbox cleanup could not be proven.",
    });
  });

  it("recognizes typed sandbox abort without reading late signal state", async () => {
    const aborted = new SandboxBackendError("aborted", "private detail");
    const backend: RuntimeSandboxBackend = {
      executeRuntime: async () => Promise.reject(aborted),
    };

    await expect(
      executor(backend, new FakeRequestMaterializer()).execute({
        request: request(),
        image: fixtureImage,
        profile: fixtureProfile,
        source,
        startBarrier: startBarrier(),
      }),
    ).rejects.toMatchObject({ code: "cancelled", cause: aborted });
  });

  it("retains barrier and release failures in an in-memory aggregate", async () => {
    const barrierFailure = new Error("journal uncertain");
    const releaseFailure = new Error("request cleanup uncertain");
    const requests = new FakeRequestMaterializer();
    requests.release = async () => Promise.reject(releaseFailure);
    const backend = new FakeBackend(outcome(framed(successfulFrames())));

    const error = await executor(backend, requests)
      .execute({
        request: request(),
        image: fixtureImage,
        profile: fixtureProfile,
        source,
        startBarrier: startBarrier(
          vi.fn(async () => Promise.reject(barrierFailure)),
        ),
      })
      .catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: "request_release_failed" });
    expect(error.cause).toBeInstanceOf(AggregateError);
    expect((error.cause as AggregateError).errors).toEqual([
      barrierFailure,
      releaseFailure,
    ]);
    expect(backend.calls).toHaveLength(0);
  });
});
