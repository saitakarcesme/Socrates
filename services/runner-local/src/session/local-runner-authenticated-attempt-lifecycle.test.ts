import {
  runnerExecutionV1Schema,
  type RunnerTaskDeliveryV1,
} from "@socrates/contracts";
import {
  encodeRuntimeMessage,
  runtimeFrameSchema,
  runtimeProtocolLimits,
  type RuntimeFrame,
} from "@socrates/runtime-protocol";
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pack } from "tar-stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { issueAdmittedSandboxImage } from "../image/capability";
import type { SandboxExecutionResult } from "../oci/backend";
import { sourceSnapshotMediaType } from "../source/materializer";
import type { LocalAttemptSandboxOwner } from "./local-attempt-owner";
import type { LocalAttemptDispatchObserver } from "./local-attempt-dispatch-loop";
import {
  LocalRunnerAuthenticatedAttemptLifecycle,
  LocalRunnerAuthenticatedAttemptLifecycleError,
  type LocalRunnerAuthenticatedAttemptLifecycleOptions,
} from "./local-runner-authenticated-attempt-lifecycle";
import taskFixture from "../../../../packages/contracts/fixtures/runner/task-v2.json";

const runnerId = "10000000-0000-4000-8000-000000000001";
const attemptId = "20000000-0000-4000-8000-000000000002";
const deliveryId = "40000000-0000-4000-8000-000000000004";
const credential = `srt1.90000000-0000-4000-8000-000000000009.${"a".repeat(43)}`;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "socrates-auth-lifecycle-"));
  roots.push(value);
  return value;
}

async function absent(path: string): Promise<boolean> {
  try {
    await stat(path);
    return false;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      return true;
    }
    throw cause;
  }
}

function portable(path: string): string {
  return path.replace(/^[A-Za-z]:/u, "").replaceAll("\\", "/");
}

function configuration(parent: string) {
  const privateRoot = portable(parent);
  return {
    version: "1",
    identity: { deploymentId: "runner-auth-1", runnerId },
    controlPlane: {
      origin: "https://control.socrates.test",
      timeoutMs: 10_000,
      maximumResponseBytes: 1_048_576,
    },
    roots: {
      artifacts: `${privateRoot}/artifacts`,
      sources: `${privateRoot}/sources`,
      journal: `${privateRoot}/journal`,
      spool: `${privateRoot}/spool`,
    },
    engine: {
      executable: "nerdctl",
      readinessTtlMs: 30_000,
      controlTimeoutMs: 10_000,
      executionTimeoutMs: 300_000,
      maximumControlOutputBytes: 262_144,
    },
    source: {
      maximumArchiveBytes: 2_097_152,
      maximumExpandedBytes: 8_388_608,
      maximumEntries: 1_000,
      maximumFileBytes: 2_097_152,
      maximumPathBytes: 4_096,
      maximumComponentBytes: 255,
      maximumPathDepth: 64,
    },
    request: { maximumBytes: 1_048_576 },
    runtime: {
      maximumProtocolBytes: 524_288,
      maximumChildOutputBytes: 2_097_152,
    },
    execution: {
      maximumWallTimeMs: 300_000,
      maximumMemoryBytes: 1_073_741_824,
      maximumPids: 128,
      maximumWritableBytes: 1_073_741_824,
      maximumRuntimeOutputBytes: 2_097_152,
      maximumCommandCount: 3,
      temporaryBytes: 67_108_864,
      sharedMemoryBytes: 67_108_864,
      cpuQuotaPeriodMicros: 100_000,
      minimumCpuQuotaMicros: 1_000,
      maximumCpuQuotaMicros: 100_000,
    },
    durability: {
      journal: {
        maximumManifestBytes: 10_000,
        maximumClaimBytes: 1_000_000,
        maximumItems: 100,
        maximumJournalBytes: 10_000_000,
      },
      spool: {
        maximumSegmentBytes: 1_000_000,
        maximumEventsPerSegment: 100,
        maximumAttempts: 100,
        maximumSpoolBytes: 10_000_000,
      },
    },
    lifecycle: {
      leaseDurationMs: 30_000,
      heartbeatIntervalMs: 10_000,
      revocationGracePeriodMs: 0,
      maximumRecoveryAttempts: 1,
      pollIntervalMs: 25,
    },
  };
}

function encoded(value: string): string {
  return Buffer.from(value).toString("base64");
}

function runtimeFrames(): RuntimeFrame[] {
  const measurement = '{"schema":"metric-value.v1","value":"1.25"}';
  return [
    { type: "command.started", phase: "action", commandIndex: 0 },
    {
      type: "command.exited",
      phase: "action",
      commandIndex: 0,
      exitCode: 0,
      signal: null,
      durationMs: 4,
    },
    { type: "command.started", phase: "measurement", commandIndex: 0 },
    {
      type: "command.exited",
      phase: "measurement",
      commandIndex: 0,
      exitCode: 0,
      signal: null,
      durationMs: 5,
    },
    {
      type: "measurement.result",
      sequence: 0,
      final: true,
      bytes: encoded(measurement),
    },
    { type: "runtime.completed", status: "succeeded" },
  ].map((frame) => runtimeFrameSchema.parse(frame));
}

function runtimeOutcome(): SandboxExecutionResult {
  const messages = runtimeFrames().map((frame) =>
    encodeRuntimeMessage(
      runtimeFrameSchema,
      frame,
      runtimeProtocolLimits.maximumFrameBytes,
    ),
  );
  const stdoutBytes = new Uint8Array(
    messages.reduce((total, message) => total + message.byteLength, 0),
  );
  let offset = 0;
  for (const message of messages) {
    stdoutBytes.set(message, offset);
    offset += message.byteLength;
  }
  return Object.freeze({
    exitCode: 0,
    stdout: "",
    stderr: "",
    stdoutBytes,
    stderrBytes: new Uint8Array(),
    durationMs: 9,
  });
}

async function archive(): Promise<Buffer> {
  const stream = pack();
  stream.entry(
    { name: "scripts/measure.mjs", type: "file", mode: 0o644 },
    "console.log('measured');\n",
  );
  stream.finalize();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

type HarnessOptions = Readonly<{
  archiveBytes?: Uint8Array;
  mode?: "idle" | "measured";
  observe?: LocalAttemptDispatchObserver["observe"];
  wait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}>;

function harness(parent: string, options: HarnessOptions = {}) {
  const order: string[] = [];
  const sourceDigest = options.archiveBytes
    ? digest(options.archiveBytes)
    : taskFixture.source.digest;
  const task = structuredClone(taskFixture);
  task.source.digest = sourceDigest;
  const execution = runnerExecutionV1Schema.parse({
    version: "1",
    lease: {
      version: "1",
      runnerId,
      taskId: task.taskId,
      attemptId,
      fence: 4,
      leasedUntil: "2026-08-02T02:00:00.000Z",
    },
    task,
  });
  const delivery: RunnerTaskDeliveryV1 = {
    version: "1",
    deliveryId,
    taskId: task.taskId,
  };
  let acquired = false;
  const submitted: unknown[] = [];
  const requests: Array<{ headers: Headers; path: string; body: unknown }> = [];
  const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body)) as unknown;
    const headers = new Headers(init?.headers);
    requests.push({ path: url.pathname, headers, body });
    if (url.pathname.endsWith("/task-deliveries/acquire")) {
      if (options.mode === "measured" && !acquired) {
        acquired = true;
        return jsonResponse({ version: "1", delivery });
      }
      return new Response(null, { status: 204 });
    }
    if (url.pathname.endsWith(`/task-deliveries/${deliveryId}/claims`)) {
      return jsonResponse({ version: "1", execution });
    }
    if (url.pathname.endsWith("/heartbeat")) {
      return jsonResponse({
        version: "1",
        leaseExpiresAt: "2026-08-02T02:00:30.000Z",
        directive: "continue",
      });
    }
    if (url.pathname.endsWith("/source-snapshots/resolve")) {
      if (!options.archiveBytes) throw new Error("Missing archive fixture.");
      return new Response(options.archiveBytes, {
        headers: {
          "content-length": String(options.archiveBytes.byteLength),
          "content-type": sourceSnapshotMediaType,
        },
      });
    }
    if (url.pathname.endsWith("/events")) {
      const candidate = body as {
        event: { eventId: string; attemptId: string; sequence: number };
      };
      submitted.push(candidate.event);
      return jsonResponse({
        version: "1",
        replay: false,
        acknowledgement: {
          version: "1",
          eventId: candidate.event.eventId,
          attemptId: candidate.event.attemptId,
          acknowledgedSequence: candidate.event.sequence,
          expectedSequence: candidate.event.sequence + 1,
          receivedAt: "2026-08-02T00:00:02.000Z",
        },
      });
    }
    throw new Error(`Unexpected test route ${url.pathname}.`);
  });
  const recoverOwned = vi.fn(async () => {
    order.push("sandbox.recover");
    return 0;
  });
  const cancel = vi.fn(async () =>
    Object.freeze({ state: "terminated" as const, forced: true }),
  );
  const executeRuntime = vi.fn(async () => runtimeOutcome());
  const sandbox: LocalAttemptSandboxOwner = {
    recoverOwned,
    cancel,
    executeRuntime,
  };
  const image = issueAdmittedSandboxImage({
    reference: execution.task.environment.imageDigest,
    localName: "trusted@digest",
    digest: execution.task.environment.imageDigest,
    configurationDigest: `sha256:${"d".repeat(64)}`,
    architecture: execution.task.environment.architecture,
    runtime: { executable: "/runtime", arguments: [] },
    profileProbe: { executable: "/probe", arguments: [] },
  });
  const admit = vi.fn(async () => image);
  const wait = vi.fn(async (delayMs: number, signal: AbortSignal) => {
    order.push(`wait:${delayMs}`);
    if (options.wait) return options.wait(delayMs, signal);
    return new Promise<void>((_resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  });
  let clock = 10;
  const now = vi.fn(() => {
    const value = clock;
    clock += 3;
    return value;
  });
  const observe = vi.fn(async (result) => {
    order.push(`observe:${result.state}`);
    await options.observe?.(result);
  });
  let event = 1;
  const journalAttemptId = vi.fn(() => attemptId);
  const journalNow = vi.fn(() => new Date("2026-08-02T00:00:00.000Z"));
  const eventId = vi.fn(
    () => `30000000-0000-4000-8000-${(event++).toString(16).padStart(12, "0")}`,
  );
  const spoolNow = vi.fn(() => new Date("2026-08-02T00:00:01.000Z"));
  const sync = vi.fn(async () => undefined);
  const valueConfiguration = configuration(parent);
  const lifecycleOptions = {
    configuration: valueConfiguration,
    credential,
    fetch: fetchImplementation,
    sandbox,
    images: { admit },
    scheduler: { wait },
    time: { now },
    observer: { observe },
    journalIdentity: { attemptId: journalAttemptId, now: journalNow },
    spoolIdentity: { eventId, now: spoolNow },
    directorySync: { sync },
  } satisfies LocalRunnerAuthenticatedAttemptLifecycleOptions;
  return {
    admit,
    cancel,
    configuration: valueConfiguration,
    eventId,
    executeRuntime,
    fetchImplementation,
    journalAttemptId,
    lifecycleOptions,
    now,
    observe,
    order,
    recoverOwned,
    requests,
    sandbox,
    submitted,
    sync,
    wait,
  };
}

function expectNoEffects(value: ReturnType<typeof harness>): void {
  for (const effect of [
    value.fetchImplementation,
    value.recoverOwned,
    value.cancel,
    value.executeRuntime,
    value.admit,
    value.wait,
    value.now,
    value.observe,
    value.journalAttemptId,
    value.eventId,
    value.sync,
  ]) {
    expect(effect).not.toHaveBeenCalled();
  }
}

describe("LocalRunnerAuthenticatedAttemptLifecycle", () => {
  it("constructs one frozen opaque graph without fetch or resource effects", async () => {
    const parent = await root();
    const value = harness(parent);

    const lifecycle = new LocalRunnerAuthenticatedAttemptLifecycle(
      value.lifecycleOptions,
    );

    expect(Object.isFrozen(lifecycle)).toBe(true);
    expect(Object.keys(lifecycle)).toEqual([]);
    expectNoEffects(value);
    for (const path of Object.values(value.configuration.roots)) {
      await expect(absent(path)).resolves.toBe(true);
    }
  });

  it("rejects configuration before reading credential or dependency properties", () => {
    const reads: PropertyKey[] = [];
    const options = new Proxy(
      { configuration: null },
      {
        get(target, property, receiver) {
          if (property === "configuration") {
            return Reflect.get(target, property, receiver);
          }
          reads.push(property);
          throw new Error("private option getter");
        },
      },
    );

    expect(
      () =>
        new LocalRunnerAuthenticatedAttemptLifecycle(
          options as unknown as LocalRunnerAuthenticatedAttemptLifecycleOptions,
        ),
    ).toThrow(
      expect.objectContaining({
        code: "invalid_configuration",
        message: "Authenticated local runner attempt configuration is invalid.",
      }),
    );
    expect(reads).toEqual([]);
  });

  it.each([null, "not-a-token", `Bearer ${credential}`])(
    "rejects malformed credential %# without reading fetch",
    async (candidate) => {
      const parent = await root();
      const value = harness(parent);
      let fetchReads = 0;
      const options = Object.defineProperty(
        { ...value.lifecycleOptions, credential: candidate },
        "fetch",
        {
          get: () => {
            fetchReads += 1;
            throw new Error("fetch must remain unread");
          },
        },
      );

      const failure = (() => {
        try {
          new LocalRunnerAuthenticatedAttemptLifecycle(
            options as LocalRunnerAuthenticatedAttemptLifecycleOptions,
          );
        } catch (cause) {
          return cause;
        }
        throw new Error("Expected construction failure.");
      })();
      expect(failure).toMatchObject({
        code: "invalid_credential",
        message: "Authenticated local runner credential is invalid.",
      });
      expect(String(failure)).not.toContain(String(candidate));
      expect(JSON.stringify(failure)).not.toContain(String(candidate));
      expect(fetchReads).toBe(0);
      expectNoEffects(value);
    },
  );

  it("normalizes a throwing credential getter without reading fetch", async () => {
    const parent = await root();
    const value = harness(parent);
    let fetchReads = 0;
    const options = Object.defineProperties(
      { ...value.lifecycleOptions },
      {
        credential: {
          get: () => {
            throw new Error(`private credential ${credential}`);
          },
        },
        fetch: {
          get: () => {
            fetchReads += 1;
            return value.fetchImplementation;
          },
        },
      },
    );

    const failure = (() => {
      try {
        new LocalRunnerAuthenticatedAttemptLifecycle(
          options as LocalRunnerAuthenticatedAttemptLifecycleOptions,
        );
      } catch (cause) {
        return cause;
      }
      throw new Error("Expected construction failure.");
    })();
    expect(failure).toMatchObject({ code: "invalid_credential" });
    expect(String(failure)).not.toContain(credential);
    expect(JSON.stringify(failure)).not.toContain(credential);
    expect(fetchReads).toBe(0);
    expectNoEffects(value);
  });

  it("reads a valid credential property exactly once", async () => {
    const parent = await root();
    const value = harness(parent);
    let reads = 0;
    const options = Object.defineProperty(
      { ...value.lifecycleOptions },
      "credential",
      {
        get: () => {
          reads += 1;
          return credential;
        },
      },
    );

    new LocalRunnerAuthenticatedAttemptLifecycle(
      options as LocalRunnerAuthenticatedAttemptLifecycleOptions,
    );
    expect(reads).toBe(1);
    expectNoEffects(value);
  });

  it.each(["missing", "non-callable", "throwing getter"] as const)(
    "rejects a %s fetch capability before effects",
    async (variant) => {
      const parent = await root();
      const value = harness(parent);
      const options = { ...value.lifecycleOptions } as Record<string, unknown>;
      if (variant === "missing") delete options["fetch"];
      else if (variant === "non-callable") options["fetch"] = 1;
      else {
        Object.defineProperty(options, "fetch", {
          get: () => {
            throw new Error("private fetch getter");
          },
        });
      }

      expect(
        () =>
          new LocalRunnerAuthenticatedAttemptLifecycle(
            options as LocalRunnerAuthenticatedAttemptLifecycleOptions,
          ),
      ).toThrow(
        expect.objectContaining({
          code: "invalid_dependency",
          message: "Authenticated local runner dependency is invalid.",
        }),
      );
      expectNoEffects(value);
    },
  );

  it("normalizes a throwing downstream dependency method getter", async () => {
    const parent = await root();
    const value = harness(parent);
    const cause = new Error("private observer getter");
    const observer = Object.defineProperty({}, "observe", {
      get: () => {
        throw cause;
      },
    });

    try {
      new LocalRunnerAuthenticatedAttemptLifecycle({
        ...value.lifecycleOptions,
        observer,
      } as LocalRunnerAuthenticatedAttemptLifecycleOptions);
      throw new Error("Expected construction failure.");
    } catch (error) {
      expect(error).toMatchObject({
        code: "invalid_dependency",
        message: "Authenticated local runner dependency is invalid.",
      });
      expect(String(error)).not.toContain("private observer getter");
    }
    expectNoEffects(value);
  });

  it("captures fetch and dependency methods, then owns one authenticated idle run", async () => {
    const parent = await root();
    const controller = new AbortController();
    const reason = Symbol("idle stop");
    const value = harness(parent, {
      wait: async (_delayMs, signal) => {
        controller.abort(reason);
        return Promise.reject(signal.reason);
      },
    });
    const originalFetch = value.lifecycleOptions.fetch;
    const originalRecovery = value.sandbox.recoverOwned;
    const originalObserve = value.lifecycleOptions.observer.observe;
    const lifecycle = new LocalRunnerAuthenticatedAttemptLifecycle(
      value.lifecycleOptions,
    );
    value.lifecycleOptions.fetch = vi.fn(async () => {
      throw new Error("mutated fetch");
    });
    value.sandbox.recoverOwned = vi.fn(async () => {
      throw new Error("mutated recovery");
    });
    value.lifecycleOptions.observer.observe = vi.fn(async () => {
      throw new Error("mutated observer");
    });

    const first = lifecycle.run(controller.signal);
    const second = lifecycle.run(controller.signal);
    expect(second).toBe(first);
    await expect(first).resolves.toEqual({ state: "stopped" });
    expect(originalFetch).toHaveBeenCalledOnce();
    expect(originalRecovery).toHaveBeenCalledOnce();
    expect(originalObserve).toHaveBeenCalledWith({ state: "idle" });
    expect(value.requests).toHaveLength(1);
    expect(value.requests[0]).toMatchObject({
      path: "/v1/runner/task-deliveries/acquire",
      body: { version: "1" },
    });
    expect(value.requests[0]?.headers.get("authorization")).toBe(
      `Bearer ${credential}`,
    );
    expect(value.order).toEqual(["sandbox.recover", "observe:idle", "wait:25"]);
  });

  it("stops a pre-aborted first run without fetch or resource effects", async () => {
    const parent = await root();
    const value = harness(parent);
    const lifecycle = new LocalRunnerAuthenticatedAttemptLifecycle(
      value.lifecycleOptions,
    );
    const controller = new AbortController();
    controller.abort(Object.freeze({ private: "shutdown" }));

    await expect(lifecycle.run(controller.signal)).resolves.toEqual({
      state: "stopped",
    });
    expectNoEffects(value);
  });

  it("retains one authenticated transport failure without rebuilding", async () => {
    const parent = await root();
    const value = harness(parent);
    const originalFetch = vi.fn<typeof fetch>(async () => {
      throw new Error("connection unavailable");
    });
    value.lifecycleOptions.fetch = originalFetch;
    const lifecycle = new LocalRunnerAuthenticatedAttemptLifecycle(
      value.lifecycleOptions,
    );
    const controller = new AbortController();

    const firstError = await lifecycle
      .run(controller.signal)
      .catch((error) => error);
    const secondError = await lifecycle
      .run(controller.signal)
      .catch((error) => error);
    expect(secondError).toBe(firstError);
    expect(firstError).toMatchObject({ code: "dispatch_failed" });
    expect(originalFetch).toHaveBeenCalledOnce();
    expect(value.recoverOwned).toHaveBeenCalledOnce();
  });

  it("applies the configured control-plane response ceiling", async () => {
    const parent = await root();
    const value = harness(parent);
    value.configuration.controlPlane.maximumResponseBytes = 32;
    const fetchImplementation = vi.fn<typeof fetch>(async () =>
      jsonResponse({ padding: "x".repeat(64) }),
    );
    value.lifecycleOptions.fetch = fetchImplementation;
    const lifecycle = new LocalRunnerAuthenticatedAttemptLifecycle(
      value.lifecycleOptions,
    );

    await expect(
      lifecycle.run(new AbortController().signal),
    ).rejects.toMatchObject({ code: "dispatch_failed" });
    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(value.observe).not.toHaveBeenCalled();
  });

  it("applies the configured control-plane request timeout", async () => {
    const parent = await root();
    const value = harness(parent);
    value.configuration.controlPlane.timeoutMs = 15;
    let transportSignal: AbortSignal | null = null;
    const fetchImplementation = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          transportSignal = init?.signal ?? null;
          transportSignal?.addEventListener(
            "abort",
            () => reject(transportSignal?.reason),
            { once: true },
          );
        }),
    );
    value.lifecycleOptions.fetch = fetchImplementation;
    const lifecycle = new LocalRunnerAuthenticatedAttemptLifecycle(
      value.lifecycleOptions,
    );

    await expect(
      lifecycle.run(new AbortController().signal),
    ).rejects.toMatchObject({ code: "dispatch_failed" });
    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(transportSignal?.aborted).toBe(true);
  });

  it("applies the configured source archive ceiling to authenticated transport", async () => {
    const parent = await root();
    const archiveBytes = await archive();
    const controller = new AbortController();
    const value = harness(parent, {
      archiveBytes,
      mode: "measured",
      observe: async (result) => {
        if (result.state === "settled") controller.abort(Symbol("bounded"));
      },
    });
    value.configuration.source.maximumArchiveBytes =
      archiveBytes.byteLength - 1;
    const lifecycle = new LocalRunnerAuthenticatedAttemptLifecycle(
      value.lifecycleOptions,
    );

    await expect(lifecycle.run(controller.signal)).resolves.toEqual({
      state: "stopped",
    });
    expect(
      value.requests.some((request) =>
        request.path.endsWith("/source-snapshots/resolve"),
      ),
    ).toBe(true);
    expect(value.executeRuntime).not.toHaveBeenCalled();
    expect(value.submitted).toContainEqual(
      expect.objectContaining({
        type: "task.failed",
        payload: expect.objectContaining({ classification: "infrastructure" }),
      }),
    );
    expect(value.observe).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "settled",
        result: expect.objectContaining({ state: "completed" }),
      }),
    );
  }, 15_000);

  it("uses one authenticated client for measured control-plane and source transport", async () => {
    const parent = await root();
    const archiveBytes = await archive();
    const controller = new AbortController();
    const observed: unknown[] = [];
    const value = harness(parent, {
      archiveBytes,
      mode: "measured",
      observe: async (result) => {
        observed.push(result);
        if (result.state === "settled") {
          controller.abort(Symbol("measured stop"));
        }
      },
    });
    const lifecycle = new LocalRunnerAuthenticatedAttemptLifecycle(
      value.lifecycleOptions,
    );

    await expect(lifecycle.run(controller.signal)).resolves.toEqual({
      state: "stopped",
    });
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({
      state: "settled",
      path: "fresh",
      deliveryId,
      result: {
        state: "completed",
        publication: { state: "completed", publication: "appended" },
        authority: { state: "stopped" },
      },
    });
    const paths = value.requests.map((request) => request.path);
    expect(paths).toContain("/v1/runner/task-deliveries/acquire");
    expect(paths).toContain(`/v1/runner/task-deliveries/${deliveryId}/claims`);
    expect(paths).toContain(
      `/v1/runner/tasks/${taskFixture.taskId}/attempts/${attemptId}/source-snapshots/resolve`,
    );
    expect(paths.filter((path) => path.endsWith("/events"))).toHaveLength(5);
    expect(
      value.requests.every(
        (request) =>
          request.headers.get("authorization") === `Bearer ${credential}`,
      ),
    ).toBe(true);
    expect(value.submitted).toHaveLength(5);
    expect(value.executeRuntime).toHaveBeenCalledOnce();
    expect(value.admit).toHaveBeenCalledOnce();
    await expect(absent(join(parent, "artifacts"))).resolves.toBe(false);
    await expect(absent(join(parent, "journal"))).resolves.toBe(false);
    await expect(absent(join(parent, "spool"))).resolves.toBe(false);
  }, 15_000);

  it("publishes fixed errors without serializing a credential", () => {
    const cause = new Error(`private ${credential}`);
    const error = new LocalRunnerAuthenticatedAttemptLifecycleError(
      "invalid_credential",
      { cause },
    );

    expect(error).toMatchObject({
      name: "LocalRunnerAuthenticatedAttemptLifecycleError",
      code: "invalid_credential",
      message: "Authenticated local runner credential is invalid.",
      cause,
    });
    expect(Object.isFrozen(error)).toBe(true);
    expect(String(error)).not.toContain(credential);
    expect(JSON.stringify(error)).not.toContain(credential);
  });
});
