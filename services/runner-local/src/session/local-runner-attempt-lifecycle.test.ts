import {
  runnerExecutionV1Schema,
  type RunnerTaskDeliveryV1,
  type RunnerTaskHeartbeatResponseV1,
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
  LocalRunnerAttemptLifecycle,
  LocalRunnerAttemptLifecycleError,
  type LocalRunnerAttemptControlPlane,
  type LocalRunnerAttemptLifecycleOptions,
} from "./local-runner-attempt-lifecycle";
import taskFixture from "../../../../packages/contracts/fixtures/runner/task-v2.json";

const attemptId = "20000000-0000-4000-8000-000000000002";
const deliveryId = "40000000-0000-4000-8000-000000000004";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "socrates-runner-lifecycle-"));
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
    identity: {
      deploymentId: "runner-test-1",
      runnerId: "10000000-0000-4000-8000-000000000001",
    },
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
      executable: "/usr/local/bin/nerdctl",
      address: "unix:///run/containerd/containerd.sock",
      snapshotter: "overlayfs",
      dataRoot: "/home/socrates/.local/share/socrates/nerdctl",
      configurationPath: "/etc/socrates/runner-local/nerdctl.toml",
      workingDirectory: "/home/socrates/.local/state/socrates/runner",
      environment: {
        home: "/home/socrates",
        path: "/usr/local/bin:/usr/bin:/bin",
        xdgConfigHome: "/home/socrates/.config/socrates",
        xdgDataHome: "/home/socrates/.local/share/socrates",
        xdgRuntimeDirectory: "/run/user/1001",
        dockerConfigDirectory: "/home/socrates/.config/socrates/docker",
      },
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

function continued(): RunnerTaskHeartbeatResponseV1 {
  return {
    version: "1",
    leaseExpiresAt: "2026-08-02T02:00:30.000Z",
    directive: "continue",
  };
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

async function* content(bytes: Uint8Array) {
  yield bytes.subarray(0, Math.min(17, bytes.byteLength));
  if (bytes.byteLength > 17) yield bytes.subarray(17);
}

type HarnessOptions = Readonly<{
  archiveBytes?: Uint8Array;
  deliver?: boolean;
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
      runnerId: "10000000-0000-4000-8000-000000000001",
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
  let event = 1;
  let clock = 10;
  const acquireTaskDelivery = vi.fn(async () => {
    order.push("control.acquire");
    if (options.deliver && !acquired) {
      acquired = true;
      return delivery;
    }
    return null;
  });
  const claimTaskDelivery = vi.fn(async () => execution);
  const claimTask = vi.fn(async () => execution);
  const reconcileAttempt = vi.fn(async () => ({
    version: "1" as const,
    state: "current" as const,
    observedAt: "2026-08-02T00:00:00.000Z",
    leaseExpiresAt: "2026-08-02T02:00:30.000Z",
  }));
  const heartbeat = vi.fn(async () => continued());
  const submitEvent = vi.fn(async (candidate) => ({
    version: "1" as const,
    replay: false,
    acknowledgement: {
      version: "1" as const,
      eventId: candidate.eventId,
      attemptId: candidate.attemptId,
      acknowledgedSequence: candidate.sequence,
      expectedSequence: candidate.sequence + 1,
      receivedAt: "2026-08-02T00:00:02.000Z",
    },
  }));
  const open = vi.fn(async () =>
    options.archiveBytes
      ? {
          mediaType: sourceSnapshotMediaType,
          sizeBytes: options.archiveBytes.byteLength,
          content: content(options.archiveBytes),
        }
      : undefined,
  );
  const controlPlane: LocalRunnerAttemptControlPlane = {
    acquireTaskDelivery,
    claimTaskDelivery,
    claimTask,
    reconcileAttempt,
    heartbeat,
    submitEvent,
    open,
  };
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
  const now = vi.fn(() => {
    const value = clock;
    clock += 3;
    return value;
  });
  const observe = vi.fn(async (result) => {
    order.push(`observe:${result.state}`);
    await options.observe?.(result);
  });
  const journalAttemptId = vi.fn(() => attemptId);
  const journalNow = vi.fn(() => new Date("2026-08-02T00:00:00.000Z"));
  const eventId = vi.fn(
    () => `30000000-0000-4000-8000-${(event++).toString(16).padStart(12, "0")}`,
  );
  const spoolNow = vi.fn(() => new Date("2026-08-02T00:00:01.000Z"));
  const sync = vi.fn(async () => undefined);
  const valueConfiguration = configuration(parent);
  const lifecycleOptions: LocalRunnerAttemptLifecycleOptions = {
    configuration: valueConfiguration,
    controlPlane,
    sandbox,
    images: { admit },
    scheduler: { wait },
    time: { now },
    observer: { observe },
    journalIdentity: { attemptId: journalAttemptId, now: journalNow },
    spoolIdentity: { eventId, now: spoolNow },
    directorySync: { sync },
  };
  return {
    admit,
    acquireTaskDelivery,
    cancel,
    claimTask,
    claimTaskDelivery,
    configuration: valueConfiguration,
    controlPlane,
    delivery,
    eventId,
    executeRuntime,
    heartbeat,
    journalAttemptId,
    lifecycleOptions,
    now,
    observe,
    open,
    order,
    reconcileAttempt,
    recoverOwned,
    sandbox,
    submitEvent,
    sync,
    wait,
  };
}

function expectNoEffects(value: ReturnType<typeof harness>): void {
  for (const effect of [
    value.acquireTaskDelivery,
    value.claimTaskDelivery,
    value.claimTask,
    value.reconcileAttempt,
    value.heartbeat,
    value.submitEvent,
    value.open,
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

describe("LocalRunnerAttemptLifecycle", () => {
  it("constructs one frozen opaque graph without any external or filesystem effect", async () => {
    const parent = await root();
    const value = harness(parent);

    const lifecycle = new LocalRunnerAttemptLifecycle(value.lifecycleOptions);

    expect(Object.isFrozen(lifecycle)).toBe(true);
    expect(Object.keys(lifecycle)).toEqual([]);
    expectNoEffects(value);
    for (const path of Object.values(value.configuration.roots)) {
      await expect(absent(path)).resolves.toBe(true);
    }
  });

  it("rejects configuration before reading any dependency property", async () => {
    const privateCause = new Error("private dependency getter");
    const reads: PropertyKey[] = [];
    const options = new Proxy(
      { configuration: null },
      {
        get(target, property, receiver) {
          if (property === "configuration") {
            return Reflect.get(target, property, receiver);
          }
          reads.push(property);
          throw privateCause;
        },
      },
    );

    expect(
      () =>
        new LocalRunnerAttemptLifecycle(
          options as unknown as LocalRunnerAttemptLifecycleOptions,
        ),
    ).toThrow(
      expect.objectContaining({
        code: "invalid_configuration",
        message: "Local runner attempt configuration is invalid.",
      }),
    );
    expect(reads).toEqual([]);
  });

  it("normalizes a throwing configuration getter without touching dependencies", () => {
    const privateCause = new Error("private configuration value");
    const options = Object.defineProperty({}, "configuration", {
      get: () => {
        throw privateCause;
      },
    });

    try {
      new LocalRunnerAttemptLifecycle(
        options as LocalRunnerAttemptLifecycleOptions,
      );
      throw new Error("Expected construction failure.");
    } catch (error) {
      expect(error).toMatchObject({
        code: "invalid_configuration",
        cause: privateCause,
        message: "Local runner attempt configuration is invalid.",
      });
      expect(String(error)).not.toContain("private configuration value");
    }
  });

  it.each([
    ["controlPlane", "acquireTaskDelivery"],
    ["controlPlane", "claimTaskDelivery"],
    ["controlPlane", "claimTask"],
    ["controlPlane", "reconcileAttempt"],
    ["controlPlane", "heartbeat"],
    ["controlPlane", "submitEvent"],
    ["controlPlane", "open"],
    ["sandbox", "recoverOwned"],
    ["sandbox", "cancel"],
    ["sandbox", "executeRuntime"],
    ["images", "admit"],
    ["scheduler", "wait"],
    ["time", "now"],
    ["observer", "observe"],
    ["journalIdentity", "attemptId"],
    ["journalIdentity", "now"],
    ["spoolIdentity", "eventId"],
    ["spoolIdentity", "now"],
    ["directorySync", "sync"],
  ] as const)(
    "rejects throwing dependency method getter %s.%s with a fixed boundary",
    async (ownerName, methodName) => {
      const parent = await root();
      const value = harness(parent);
      const privateCause = new Error("private capability detail");
      const originalOwner = value.lifecycleOptions[ownerName] as unknown as
        Record<string, unknown> | undefined;
      const owner = Object.defineProperty({ ...originalOwner }, methodName, {
        get: () => {
          throw privateCause;
        },
      });
      const lifecycleOptions = {
        ...value.lifecycleOptions,
        [ownerName]: owner,
      } as unknown as LocalRunnerAttemptLifecycleOptions;

      try {
        new LocalRunnerAttemptLifecycle(lifecycleOptions);
        throw new Error("Expected construction failure.");
      } catch (error) {
        expect(error).toMatchObject({
          code: "invalid_dependency",
          cause: privateCause,
          message: "Local runner attempt dependency is invalid.",
        });
        expect(String(error)).not.toContain("private capability detail");
      }
      expectNoEffects(value);
    },
  );

  it.each(["missing", "non-callable", "throwing proxy"] as const)(
    "rejects a %s dependency method before effects",
    async (variant) => {
      const parent = await root();
      const value = harness(parent);
      const privateCause = new Error("private proxy detail");
      const observer =
        variant === "missing"
          ? {}
          : variant === "non-callable"
            ? { observe: 1 }
            : new Proxy(
                {},
                {
                  get: () => {
                    throw privateCause;
                  },
                },
              );

      expect(
        () =>
          new LocalRunnerAttemptLifecycle({
            ...value.lifecycleOptions,
            observer,
          } as unknown as LocalRunnerAttemptLifecycleOptions),
      ).toThrow(
        expect.objectContaining({
          code: "invalid_dependency",
          message: "Local runner attempt dependency is invalid.",
        }),
      );
      expectNoEffects(value);
    },
  );

  it("normalizes a throwing dependency-owner getter", async () => {
    const parent = await root();
    const value = harness(parent);
    const cause = new Error("private sandbox owner");
    const options = Object.defineProperty(
      { ...value.lifecycleOptions },
      "sandbox",
      {
        get: () => {
          throw cause;
        },
      },
    );

    try {
      new LocalRunnerAttemptLifecycle(
        options as LocalRunnerAttemptLifecycleOptions,
      );
      throw new Error("Expected construction failure.");
    } catch (error) {
      expect(error).toMatchObject({
        code: "invalid_dependency",
        cause,
        message: "Local runner attempt dependency is invalid.",
      });
      expect(String(error)).not.toContain("private sandbox owner");
    }
    expectNoEffects(value);
  });

  it("admits exact downstream constructor boundaries during composition", async () => {
    const parent = await root();
    const value = harness(parent);
    value.configuration.runtime.maximumProtocolBytes =
      runtimeProtocolLimits.maximumFrameBytes + 4;
    value.configuration.lifecycle.leaseDurationMs = 180_000;
    value.configuration.lifecycle.heartbeatIntervalMs = 60_000;
    value.configuration.lifecycle.revocationGracePeriodMs = 60_000;

    expect(
      () => new LocalRunnerAttemptLifecycle(value.lifecycleOptions),
    ).not.toThrow();
    expectNoEffects(value);
  });

  it("captures methods, owns one run promise, and drives a real idle lifecycle", async () => {
    const parent = await root();
    const controller = new AbortController();
    const reason = Symbol("idle stop");
    const value = harness(parent, {
      wait: async (delayMs, signal) => {
        expect(delayMs).toBe(25);
        controller.abort(reason);
        return Promise.reject(signal.reason);
      },
    });
    const originals = {
      acquire: value.controlPlane.acquireTaskDelivery,
      recover: value.sandbox.recoverOwned,
      observe: value.lifecycleOptions.observer.observe,
      wait: value.lifecycleOptions.scheduler.wait,
    };
    const lifecycle = new LocalRunnerAttemptLifecycle(value.lifecycleOptions);
    value.controlPlane.acquireTaskDelivery = vi.fn(async () => value.delivery);
    value.sandbox.recoverOwned = vi.fn(async () => {
      throw new Error("mutated recovery");
    });
    value.lifecycleOptions.observer.observe = vi.fn(async () => {
      throw new Error("mutated observer");
    });
    value.lifecycleOptions.scheduler.wait = vi.fn(async () => {
      throw new Error("mutated wait");
    });

    const first = lifecycle.run(controller.signal);
    const second = lifecycle.run(controller.signal);
    expect(second).toBe(first);
    await expect(first).resolves.toEqual({ state: "stopped" });
    expect(originals.recover).toHaveBeenCalledOnce();
    expect(originals.acquire).toHaveBeenCalledOnce();
    expect(originals.observe).toHaveBeenCalledWith({ state: "idle" });
    expect(originals.wait).toHaveBeenCalledWith(25, controller.signal);
    expect(value.order).toEqual([
      "sandbox.recover",
      "control.acquire",
      "observe:idle",
      "wait:25",
    ]);
    await expect(absent(join(parent, "artifacts"))).resolves.toBe(true);
    await expect(absent(join(parent, "sources"))).resolves.toBe(false);
    await expect(absent(join(parent, "journal"))).resolves.toBe(false);
    await expect(absent(join(parent, "spool"))).resolves.toBe(false);
  });

  it("rejects an invalid signal before the first lifecycle effect", async () => {
    const parent = await root();
    const value = harness(parent);
    const lifecycle = new LocalRunnerAttemptLifecycle(value.lifecycleOptions);

    await expect(lifecycle.run({} as AbortSignal)).rejects.toMatchObject({
      code: "invalid_configuration",
    });
    expectNoEffects(value);
  });

  it("stops without effects when the first signal is already aborted", async () => {
    const parent = await root();
    const value = harness(parent);
    const lifecycle = new LocalRunnerAttemptLifecycle(value.lifecycleOptions);
    const controller = new AbortController();
    controller.abort(Object.freeze({ private: "shutdown authority" }));

    await expect(lifecycle.run(controller.signal)).resolves.toEqual({
      state: "stopped",
    });
    expectNoEffects(value);
  });

  it("retains startup failure without opening stores, acquiring, or retrying", async () => {
    const parent = await root();
    const cause = new Error("sandbox recovery unavailable");
    const value = harness(parent);
    value.sandbox.recoverOwned = vi.fn(async () => Promise.reject(cause));
    const lifecycle = new LocalRunnerAttemptLifecycle(value.lifecycleOptions);
    const controller = new AbortController();

    const firstError = await lifecycle
      .run(controller.signal)
      .catch((error) => error);
    const secondError = await lifecycle
      .run(controller.signal)
      .catch((error) => error);
    expect(secondError).toBe(firstError);
    expect(firstError).toMatchObject({ code: "dispatch_failed" });
    expect(value.sandbox.recoverOwned).toHaveBeenCalledOnce();
    expect(value.acquireTaskDelivery).not.toHaveBeenCalled();
    await expect(absent(join(parent, "journal"))).resolves.toBe(true);
    await expect(absent(join(parent, "spool"))).resolves.toBe(true);
  });

  it("retains dispatch transport failure without a second attempt", async () => {
    const parent = await root();
    const cause = new Error("control plane unavailable");
    const value = harness(parent);
    value.controlPlane.acquireTaskDelivery = vi.fn(async () =>
      Promise.reject(cause),
    );
    const lifecycle = new LocalRunnerAttemptLifecycle(value.lifecycleOptions);
    const controller = new AbortController();

    const firstError = await lifecycle
      .run(controller.signal)
      .catch((error) => error);
    const secondError = await lifecycle
      .run(controller.signal)
      .catch((error) => error);
    expect(secondError).toBe(firstError);
    expect(firstError).toMatchObject({ code: "dispatch_failed" });
    expect(value.controlPlane.acquireTaskDelivery).toHaveBeenCalledOnce();
    expect(value.recoverOwned).toHaveBeenCalledOnce();
  });

  it("retains the first observation failure without rebuilding or retrying", async () => {
    const parent = await root();
    const cause = new Error("observer unavailable");
    const value = harness(parent, {
      observe: async () => Promise.reject(cause),
    });
    const lifecycle = new LocalRunnerAttemptLifecycle(value.lifecycleOptions);
    const controller = new AbortController();

    const first = lifecycle.run(controller.signal);
    const second = lifecycle.run(controller.signal);
    expect(second).toBe(first);
    const firstError = await first.catch((error) => error);
    const secondError = await lifecycle
      .run(controller.signal)
      .catch((error) => error);
    expect(secondError).toBe(firstError);
    expect(firstError).toMatchObject({
      code: "observation_failed",
      cause,
    });
    expect(value.recoverOwned).toHaveBeenCalledOnce();
    expect(value.acquireTaskDelivery).toHaveBeenCalledOnce();
    expect(value.observe).toHaveBeenCalledOnce();
  });

  it("retains the first dispatch-delay failure without another poll", async () => {
    const parent = await root();
    const cause = new Error("timer unavailable");
    const value = harness(parent, {
      wait: async () => Promise.reject(cause),
    });
    const lifecycle = new LocalRunnerAttemptLifecycle(value.lifecycleOptions);
    const controller = new AbortController();

    const firstError = await lifecycle
      .run(controller.signal)
      .catch((error) => error);
    const secondError = await lifecycle
      .run(controller.signal)
      .catch((error) => error);
    expect(secondError).toBe(firstError);
    expect(firstError).toMatchObject({ code: "delay_failed", cause });
    expect(value.acquireTaskDelivery).toHaveBeenCalledOnce();
    expect(value.observe).toHaveBeenCalledOnce();
    expect(value.wait).toHaveBeenCalledOnce();
  });

  it("owns one measured attempt through real composed durable boundaries", async () => {
    const parent = await root();
    const archiveBytes = await archive();
    const controller = new AbortController();
    const observed: unknown[] = [];
    const value = harness(parent, {
      archiveBytes,
      deliver: true,
      observe: async (result) => {
        observed.push(result);
        if (result.state === "settled") {
          controller.abort(Symbol("measured"));
        }
      },
    });
    const lifecycle = new LocalRunnerAttemptLifecycle(value.lifecycleOptions);

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
        publication: {
          state: "completed",
          publication: "appended",
          work: { state: "completed" },
        },
        authority: { state: "stopped" },
      },
    });
    expect(value.open).toHaveBeenCalledOnce();
    expect(value.open).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshotId: taskFixture.source.snapshotId,
        digest: digest(archiveBytes),
        identity: expect.objectContaining({ attemptId, fence: 4 }),
      }),
    );
    expect(value.executeRuntime).toHaveBeenCalledOnce();
    expect(value.submitEvent).toHaveBeenCalledTimes(5);
    expect(value.admit).toHaveBeenCalledOnce();
    expect(value.heartbeat).toHaveBeenCalled();
    expect(value.sync).toHaveBeenCalled();
    await expect(absent(join(parent, "artifacts"))).resolves.toBe(false);
    await expect(absent(join(parent, "journal"))).resolves.toBe(false);
    await expect(absent(join(parent, "spool"))).resolves.toBe(false);
  }, 15_000);

  it("publishes fixed lifecycle errors with private causes retained in memory", () => {
    const cause = new Error("private dependency detail");
    const error = new LocalRunnerAttemptLifecycleError("invalid_dependency", {
      cause,
    });

    expect(error).toMatchObject({
      name: "LocalRunnerAttemptLifecycleError",
      code: "invalid_dependency",
      message: "Local runner attempt dependency is invalid.",
      cause,
    });
    expect(Object.isFrozen(error)).toBe(true);
    expect(String(error)).not.toContain("private dependency detail");
  });
});
