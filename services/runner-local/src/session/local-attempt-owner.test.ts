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
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { issueAdmittedSandboxImage } from "../image/capability";
import { runnerEventDraft } from "../lifecycle/draft";
import type { SandboxExecutionResult } from "../oci/backend";
import { issueMaterializedRuntimeRequest } from "../request/capability";
import { issueMaterializedSourceSnapshot } from "../source/capability";
import { LocalEventSpool } from "../spool/store";
import type { LeaseAuthorityScheduler } from "../supervision/lease-authority-monitor";
import type { RunnerControlPlaneClient } from "../transport/client";
import { LocalWorkJournal } from "../work-journal/store";
import {
  LocalAttemptOwner,
  LocalAttemptOwnerError,
  type LocalAttemptOwnerOptions,
} from "./local-attempt-owner";
import { captureLocalAttemptOwnerOptions } from "./local-attempt-owner-config";
import { LocalAttemptDispatchLoop } from "./local-attempt-dispatch-loop";
import taskFixture from "../../../../packages/contracts/fixtures/runner/task-v2.json";
import { issueVerifiedArtifact } from "../../../../packages/artifact-store/src/verification";

const delivery: RunnerTaskDeliveryV1 = {
  version: "1",
  deliveryId: "40000000-0000-4000-8000-000000000004",
  taskId: taskFixture.taskId,
};
const attemptId = "20000000-0000-4000-8000-000000000002";
const execution = runnerExecutionV1Schema.parse({
  version: "1",
  lease: {
    version: "1",
    runnerId: "10000000-0000-4000-8000-000000000001",
    taskId: taskFixture.taskId,
    attemptId,
    fence: 4,
    leasedUntil: "2026-08-01T02:00:00.000Z",
  },
  task: taskFixture,
});
const mebibyte = 1_024 * 1_024;
const executionPolicy = Object.freeze({
  maximumWallTimeMs: 300_000,
  maximumMemoryBytes: 1_024 * mebibyte,
  maximumPids: 128,
  maximumWritableBytes: 1_024 * mebibyte,
  maximumRuntimeOutputBytes: 2 * mebibyte,
  maximumCommandCount: 3,
  temporaryBytes: 64 * mebibyte,
  sharedMemoryBytes: 64 * mebibyte,
  cpuQuotaPeriodMicros: 100_000,
  minimumCpuQuotaMicros: 1_000,
  maximumCpuQuotaMicros: 100_000,
});
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "socrates-attempt-owner-"));
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

class SignalScheduler implements LeaseAuthorityScheduler {
  readonly waits: Array<{ delayMs: number; signal: AbortSignal }> = [];

  wait(delayMs: number, signal: AbortSignal): Promise<void> {
    this.waits.push({ delayMs, signal });
    return new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  }
}

function encoded(value: string): string {
  return Buffer.from(value).toString("base64");
}

function frames(): RuntimeFrame[] {
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
  const messages = frames().map((frame) =>
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
    leaseExpiresAt: "2026-08-01T02:00:30.000Z",
    directive: "continue",
  };
}

function harness(
  parent: string,
  overrides: Partial<LocalAttemptOwnerOptions> = {},
) {
  const order: string[] = [];
  const scheduler = new SignalScheduler();
  let event = 1;
  let clock = 10;
  const acquireTaskDelivery = vi.fn(async () => null);
  const claimTaskDelivery = vi.fn(async () => execution);
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
      receivedAt: "2026-08-01T00:00:02.000Z",
    },
  }));
  const controlPlane = {
    acquireTaskDelivery,
    claimTaskDelivery,
    claimTask: vi.fn(async () => execution),
    reconcileAttempt: vi.fn(async () => ({
      version: "1" as const,
      state: "current" as const,
      observedAt: "2026-08-01T00:00:00.000Z",
      leaseExpiresAt: "2026-08-01T02:00:30.000Z",
    })),
    heartbeat,
    submitEvent,
  } satisfies RunnerControlPlaneClient;
  const sandbox = {
    recoverOwned: vi.fn(async () => {
      order.push("sandbox.recover");
      return 0;
    }),
    cancel: vi.fn(async () =>
      Object.freeze({ state: "terminated" as const, forced: true }),
    ),
    executeRuntime: vi.fn(async () => runtimeOutcome()),
  };
  const artifact = issueVerifiedArtifact(execution.task.source.digest, 128);
  const createArtifactResolver = vi.fn((identity) =>
    Object.freeze({
      identity: Object.freeze({ ...identity }),
      resolve: async () => artifact,
    }),
  );
  const image = issueAdmittedSandboxImage({
    reference: execution.task.environment.imageDigest,
    localName: "trusted@digest",
    digest: execution.task.environment.imageDigest,
    configurationDigest: `sha256:${"d".repeat(64)}`,
    architecture: execution.task.environment.architecture,
    runtime: { executable: "/runtime", arguments: [] },
    profileProbe: { executable: "/probe", arguments: [] },
  });
  const sources = {
    recoverOwned: vi.fn(async () => {
      order.push("source.recover");
      return 0;
    }),
    materialize: vi.fn(async ({ identity }) =>
      issueMaterializedSourceSnapshot({
        path: "/private/source",
        deploymentId: "test",
        identity,
        digest: execution.task.source.digest,
        archiveBytes: 128,
        expandedBytes: 256,
        entryCount: 1,
      }),
    ),
    release: vi.fn(async () => undefined),
  };
  const requests = {
    materialize: vi.fn(async ({ bytes, identity }) =>
      issueMaterializedRuntimeRequest({
        path: "/private/request",
        deploymentId: "test",
        identity,
        digest: `sha256:${"b".repeat(64)}`,
        sizeBytes: bytes.byteLength,
      }),
    ),
    release: vi.fn(async () => undefined),
  };
  const options: LocalAttemptOwnerOptions = {
    sandbox,
    sources,
    controlPlane,
    scheduler,
    time: {
      now: () => {
        const value = clock;
        clock += 3;
        return value;
      },
    },
    artifactResolvers: { create: createArtifactResolver },
    images: { admit: async () => image },
    requests,
    journal: {
      rootPath: join(parent, "journal"),
      limits: {
        maximumManifestBytes: 10_000,
        maximumClaimBytes: 1_000_000,
        maximumItems: 10,
        maximumJournalBytes: 10_000_000,
      },
      identitySource: {
        attemptId: () => attemptId,
        now: () => new Date("2026-08-01T00:00:00.000Z"),
      },
      directorySync: {
        sync: async () => {
          order.push("journal.sync");
        },
      },
    },
    spool: {
      rootPath: join(parent, "spool"),
      limits: {
        maximumSegmentBytes: 1_000_000,
        maximumEventsPerSegment: 100,
        maximumAttempts: 10,
        maximumSpoolBytes: 10_000_000,
      },
      identitySource: {
        eventId: () =>
          `30000000-0000-4000-8000-${(event++).toString(16).padStart(12, "0")}`,
        now: () => new Date("2026-08-01T00:00:01.000Z"),
      },
      directorySync: {
        sync: async () => {
          order.push("spool.sync");
        },
      },
    },
    executionPolicy,
    runtime: {
      maximumProtocolBytes: 512 * 1_024,
      maximumChildOutputBytes: 2 * mebibyte,
    },
    leaseDurationMs: 30_000,
    heartbeatIntervalMs: 10_000,
    revocationGracePeriodMs: 0,
    maximumRecoveryAttempts: 1,
    ...overrides,
  };
  return {
    acquireTaskDelivery,
    claimTaskDelivery,
    controlPlane,
    createArtifactResolver,
    heartbeat,
    options,
    order,
    requests,
    sandbox,
    scheduler,
    sources,
    submitEvent,
  };
}

describe("LocalAttemptOwner", () => {
  it("drives one real idle owner cycle through the observed dispatch lifecycle", async () => {
    const parent = await root();
    const value = harness(parent);
    const owner = new LocalAttemptOwner(value.options);
    const controller = new AbortController();
    const reason = Symbol("idle lifecycle stop");
    const wait = vi.fn(async () => {
      controller.abort(reason);
      return Promise.reject(reason);
    });
    const observe = vi.fn(async () => undefined);
    const loop = new LocalAttemptDispatchLoop({
      owner,
      delay: { wait },
      observer: { observe },
      pollIntervalMs: 25,
    });

    await expect(loop.run(controller.signal)).resolves.toEqual({
      state: "stopped",
    });
    expect(value.acquireTaskDelivery).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledWith({ state: "idle" });
    expect(wait).toHaveBeenCalledWith(25, controller.signal);
    expect(value.order.slice(0, 2)).toEqual([
      "sandbox.recover",
      "source.recover",
    ]);
  });

  it("constructs without recovery, filesystem, transport, or session effects", async () => {
    const parent = await root();
    const value = harness(parent);

    new LocalAttemptOwner(value.options);

    expect(value.sandbox.recoverOwned).not.toHaveBeenCalled();
    expect(value.sources.recoverOwned).not.toHaveBeenCalled();
    expect(value.acquireTaskDelivery).not.toHaveBeenCalled();
    expect(value.heartbeat).not.toHaveBeenCalled();
    expect(value.sandbox.executeRuntime).not.toHaveBeenCalled();
    await expect(absent(join(parent, "journal"))).resolves.toBe(true);
    await expect(absent(join(parent, "spool"))).resolves.toBe(true);
  });

  it("recovers exact owners before opening either durable store", async () => {
    const parent = await root();
    const value = harness(parent);
    value.sandbox.recoverOwned.mockImplementation(async () => {
      expect(await absent(join(parent, "journal"))).toBe(true);
      expect(await absent(join(parent, "spool"))).toBe(true);
      value.order.push("sandbox.recover");
      return 2;
    });
    value.sources.recoverOwned.mockImplementation(async () => {
      expect(await absent(join(parent, "journal"))).toBe(true);
      expect(await absent(join(parent, "spool"))).toBe(true);
      value.order.push("source.recover");
      return 3;
    });
    value.acquireTaskDelivery.mockImplementation(async () => {
      expect(await absent(join(parent, "journal"))).toBe(false);
      expect(await absent(join(parent, "spool"))).toBe(false);
      value.order.push("acquire");
      return null;
    });
    const owner = new LocalAttemptOwner(value.options);

    await expect(owner.dispatchNext()).resolves.toEqual({ state: "idle" });
    expect(value.order.indexOf("sandbox.recover")).toBe(0);
    expect(value.order.indexOf("source.recover")).toBe(1);
    expect(value.order.indexOf("acquire")).toBeGreaterThan(1);
  });

  it("captures resource and transport methods against later mutation", async () => {
    const parent = await root();
    const value = harness(parent);
    const originalSandboxRecovery = value.sandbox.recoverOwned;
    const originalSourceRecovery = value.sources.recoverOwned;
    const originalAcquire = value.controlPlane.acquireTaskDelivery;
    const owner = new LocalAttemptOwner(value.options);
    value.sandbox.recoverOwned = vi.fn(async () => {
      throw new Error("mutated sandbox recovery");
    });
    value.sources.recoverOwned = vi.fn(async () => {
      throw new Error("mutated source recovery");
    });
    value.controlPlane.acquireTaskDelivery = vi.fn(async () => delivery);

    await expect(owner.dispatchNext()).resolves.toEqual({ state: "idle" });
    expect(originalSandboxRecovery).toHaveBeenCalledOnce();
    expect(originalSourceRecovery).toHaveBeenCalledOnce();
    expect(originalAcquire).toHaveBeenCalledOnce();
  });

  it("captures resolver creation and rejects cross-attempt capability reuse", async () => {
    const parent = await root();
    const value = harness(parent);
    const shared = Object.freeze({
      identity: Object.freeze({
        runnerId: execution.lease.runnerId,
        taskId: execution.lease.taskId,
        attemptId: execution.lease.attemptId,
        fence: execution.lease.fence,
      }),
      resolve: vi.fn(async () => undefined),
    });
    const create = vi.fn(() => shared);
    const artifactResolvers = { create };
    const captured = captureLocalAttemptOwnerOptions({
      ...value.options,
      artifactResolvers,
    });
    artifactResolvers.create = vi.fn(() => {
      throw new Error("mutated factory");
    });

    expect(captured.artifactResolvers.create(shared.identity)).toMatchObject({
      identity: shared.identity,
    });
    expect(() => captured.artifactResolvers.create(shared.identity)).toThrow(
      expect.objectContaining({
        name: "LocalAttemptOwnerError",
        code: "invalid_dependency",
      }),
    );
    expect(create).toHaveBeenCalledTimes(2);
    expect(artifactResolvers.create).not.toHaveBeenCalled();
  });

  it("issues distinct exact capabilities for sequential attempt identities", async () => {
    const parent = await root();
    const value = harness(parent);
    const issued: object[] = [];
    const artifactResolvers = {
      create: vi.fn((identity) => {
        const resolver = Object.freeze({
          identity: Object.freeze({ ...identity }),
          resolve: vi.fn(async () => undefined),
        });
        issued.push(resolver);
        return resolver;
      }),
    };
    const captured = captureLocalAttemptOwnerOptions({
      ...value.options,
      artifactResolvers,
    });
    const firstIdentity = Object.freeze({
      runnerId: execution.lease.runnerId,
      taskId: execution.lease.taskId,
      attemptId: execution.lease.attemptId,
      fence: execution.lease.fence,
    });
    const secondIdentity = Object.freeze({
      ...firstIdentity,
      attemptId: "90000000-0000-4000-8000-000000000009",
      fence: firstIdentity.fence + 1,
    });

    const first = captured.artifactResolvers.create(firstIdentity);
    const second = captured.artifactResolvers.create(secondIdentity);

    expect(first).not.toBe(second);
    expect(issued[0]).not.toBe(issued[1]);
    expect(first.identity).toEqual(firstIdentity);
    expect(second.identity).toEqual(secondIdentity);
    expect(Object.isFrozen(first.identity)).toBe(true);
    expect(Object.isFrozen(second.identity)).toBe(true);
  });

  it.each([
    [
      "equal",
      (parent: string) => join(parent, "same"),
      (parent: string) => join(parent, "same"),
    ],
    [
      "journal parent",
      (parent: string) => join(parent, "data"),
      (parent: string) => join(parent, "data", "spool"),
    ],
    [
      "spool parent",
      (parent: string) => join(parent, "data", "journal"),
      (parent: string) => join(parent, "data"),
    ],
  ])(
    "rejects %s durable roots before effects",
    async (_label, journal, spool) => {
      const parent = await root();
      const value = harness(parent);

      expect(
        () =>
          new LocalAttemptOwner({
            ...value.options,
            journal: { ...value.options.journal, rootPath: journal(parent) },
            spool: { ...value.options.spool, rootPath: spool(parent) },
          }),
      ).toThrow(LocalAttemptOwnerError);
      expect(value.sandbox.recoverOwned).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["lease duration", { leaseDurationMs: 0 }],
    ["heartbeat interval", { heartbeatIntervalMs: 10_001 }],
    ["revocation grace", { revocationGracePeriodMs: 60_001 }],
    ["recovery attempts", { maximumRecoveryAttempts: 101 }],
    [
      "runtime protocol bytes",
      { runtime: { maximumProtocolBytes: 0, maximumChildOutputBytes: 1 } },
    ],
  ])("rejects invalid %s before effects", async (_label, override) => {
    const parent = await root();
    const value = harness(parent);

    expect(
      () => new LocalAttemptOwner({ ...value.options, ...override }),
    ).toThrow(LocalAttemptOwnerError);
    expect(value.sandbox.recoverOwned).not.toHaveBeenCalled();
  });

  it("rejects a missing dependency method before effects", async () => {
    const parent = await root();
    const value = harness(parent);

    expect(
      () =>
        new LocalAttemptOwner({
          ...value.options,
          scheduler: {} as LeaseAuthorityScheduler,
        }),
    ).toThrow(
      expect.objectContaining({
        name: "LocalAttemptOwnerError",
        code: "invalid_dependency",
      }),
    );
    expect(value.sandbox.recoverOwned).not.toHaveBeenCalled();
  });

  it.each([
    [
      "throwing getter",
      () =>
        Object.defineProperty({}, "wait", {
          get: () => {
            throw new Error("private getter failure");
          },
        }),
    ],
    [
      "throwing proxy",
      () =>
        new Proxy(
          {},
          {
            get: () => {
              throw new Error("private proxy failure");
            },
          },
        ),
    ],
  ])(
    "rejects a %s dependency without leaking its cause",
    async (_label, scheduler) => {
      const parent = await root();
      const value = harness(parent);

      const failure = (() => {
        try {
          new LocalAttemptOwner({
            ...value.options,
            scheduler: scheduler() as LeaseAuthorityScheduler,
          });
        } catch (cause) {
          return cause;
        }
        throw new Error("Expected owner construction to fail.");
      })();

      expect(failure).toMatchObject({
        name: "LocalAttemptOwnerError",
        code: "invalid_dependency",
        message: "Local attempt dependency method wait is invalid.",
      });
      expect(String(failure)).not.toContain("private");
      expect(value.sandbox.recoverOwned).not.toHaveBeenCalled();
    },
  );

  it("retains startup failure without opening stores or retrying", async () => {
    const parent = await root();
    const value = harness(parent);
    const failure = new Error("private cleanup failure");
    value.sandbox.recoverOwned.mockRejectedValue(failure);
    const owner = new LocalAttemptOwner(value.options);

    const first = await owner.dispatchNext().catch((cause) => cause);
    const second = await owner.dispatchNext().catch((cause) => cause);

    expect(second).toBe(first);
    expect(value.sandbox.recoverOwned).toHaveBeenCalledOnce();
    expect(value.sources.recoverOwned).not.toHaveBeenCalled();
    expect(value.acquireTaskDelivery).not.toHaveBeenCalled();
    await expect(absent(join(parent, "journal"))).resolves.toBe(true);
    await expect(absent(join(parent, "spool"))).resolves.toBe(true);
  });

  it("does not open the spool or retry after journal opening fails", async () => {
    const parent = await root();
    const journalPath = join(parent, "journal-file");
    const spoolPath = join(parent, "spool");
    await writeFile(journalPath, "not a directory", "utf8");
    const value = harness(parent, {
      journal: { ...harness(parent).options.journal, rootPath: journalPath },
      spool: { ...harness(parent).options.spool, rootPath: spoolPath },
    });
    const owner = new LocalAttemptOwner(value.options);

    const first = await owner.dispatchNext().catch((cause) => cause);
    const second = await owner.dispatchNext().catch((cause) => cause);

    expect(second).toBe(first);
    expect(value.sandbox.recoverOwned).toHaveBeenCalledOnce();
    expect(value.sources.recoverOwned).toHaveBeenCalledOnce();
    expect(value.acquireTaskDelivery).not.toHaveBeenCalled();
    await expect(absent(spoolPath)).resolves.toBe(true);
  });

  it("exposes no graph and never retries after spool opening fails", async () => {
    const parent = await root();
    const journalPath = join(parent, "journal");
    const spoolPath = join(parent, "spool-file");
    await writeFile(spoolPath, "not a directory", "utf8");
    const defaults = harness(parent);
    const value = harness(parent, {
      journal: { ...defaults.options.journal, rootPath: journalPath },
      spool: { ...defaults.options.spool, rootPath: spoolPath },
    });
    const owner = new LocalAttemptOwner(value.options);

    const first = await owner.dispatchNext().catch((cause) => cause);
    const second = await owner.dispatchNext().catch((cause) => cause);

    expect(second).toBe(first);
    expect(value.sandbox.recoverOwned).toHaveBeenCalledOnce();
    expect(value.sources.recoverOwned).toHaveBeenCalledOnce();
    expect(value.acquireTaskDelivery).not.toHaveBeenCalled();
    await expect(absent(journalPath)).resolves.toBe(false);
  });

  it("serializes concurrent dispatch through each complete admission", async () => {
    const parent = await root();
    const value = harness(parent);
    const firstAcquire = deferred<RunnerTaskDeliveryV1 | null>();
    const secondAcquire = deferred<RunnerTaskDeliveryV1 | null>();
    value.acquireTaskDelivery
      .mockImplementationOnce(() => firstAcquire.promise)
      .mockImplementationOnce(() => secondAcquire.promise);
    const owner = new LocalAttemptOwner(value.options);

    const first = owner.dispatchNext();
    const second = owner.dispatchNext();
    await vi.waitFor(() =>
      expect(value.acquireTaskDelivery).toHaveBeenCalledOnce(),
    );
    firstAcquire.resolve(null);
    await expect(first).resolves.toEqual({ state: "idle" });
    await vi.waitFor(() =>
      expect(value.acquireTaskDelivery).toHaveBeenCalledTimes(2),
    );
    secondAcquire.resolve(null);
    await expect(second).resolves.toEqual({ state: "idle" });
    expect(value.sandbox.recoverOwned).toHaveBeenCalledOnce();
    expect(value.sources.recoverOwned).toHaveBeenCalledOnce();
  });

  it("owns a measured fresh attempt through real journal and spool completion", async () => {
    const parent = await root();
    const mutablePolicy = { ...executionPolicy };
    const value = harness(parent, { executionPolicy: mutablePolicy });
    value.acquireTaskDelivery
      .mockResolvedValueOnce(delivery)
      .mockResolvedValue(null);
    const originalRuntime = value.sandbox.executeRuntime;
    const originalMaterialize = value.sources.materialize;
    const originalSubmit = value.controlPlane.submitEvent;
    const owner = new LocalAttemptOwner(value.options);
    mutablePolicy.maximumWallTimeMs = 0;
    value.sandbox.executeRuntime = vi.fn(async () => {
      throw new Error("mutated runtime");
    });
    value.sources.materialize = vi.fn(async () => {
      throw new Error("mutated source materializer");
    });
    value.controlPlane.submitEvent = vi.fn(async () => {
      throw new Error("mutated event transport");
    });

    await expect(owner.dispatchNext()).resolves.toMatchObject({
      state: "settled",
      path: "fresh",
      deliveryId: delivery.deliveryId,
      execution,
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
    expect(originalSubmit).toHaveBeenCalledTimes(5);
    expect(originalRuntime).toHaveBeenCalledOnce();
    expect(originalMaterialize).toHaveBeenCalledOnce();
    expect(value.sources.release).toHaveBeenCalledOnce();
    expect(value.requests.materialize).toHaveBeenCalledOnce();
    expect(value.requests.release).toHaveBeenCalledOnce();

    await expect(owner.dispatchNext()).resolves.toEqual({ state: "idle" });
    expect(value.sandbox.recoverOwned).toHaveBeenCalledOnce();
    expect(value.sources.recoverOwned).toHaveBeenCalledOnce();
  });

  it("routes restarted pending evidence through the shared recovery graph only", async () => {
    const parent = await root();
    const value = harness(parent);
    const journal = await LocalWorkJournal.open(value.options.journal);
    await journal.admit(delivery);
    await journal.commitClaim(delivery.deliveryId, execution);
    await journal.commitExecutionStart(delivery.deliveryId, execution);
    const spool = await LocalEventSpool.open(value.options.spool);
    const events = await spool.append(execution, [
      runnerEventDraft({
        type: "action.started",
        payload: { commandIndex: 0 },
      }),
      runnerEventDraft({
        type: "task.failed",
        payload: {
          classification: "infrastructure",
          message: "Fixed owner restart recovery test failure.",
        },
      }),
    ]);
    const first = events[0]!;
    await spool.acknowledge(execution, {
      version: "1",
      eventId: first.eventId,
      attemptId: first.attemptId,
      acknowledgedSequence: first.sequence,
      expectedSequence: first.sequence + 1,
      receivedAt: "2026-08-01T00:00:02.000Z",
    });
    const owner = new LocalAttemptOwner(value.options);

    await expect(owner.dispatchNext()).resolves.toMatchObject({
      state: "settled",
      path: "restart_recovery",
      deliveryId: delivery.deliveryId,
      execution,
      result: {
        state: "completed",
        publication: {
          publication: "recovered",
          work: { state: "completed" },
        },
        authority: { state: "stopped" },
      },
    });
    expect(value.acquireTaskDelivery).not.toHaveBeenCalled();
    expect(value.submitEvent).toHaveBeenCalledOnce();
    expect(value.submitEvent.mock.calls[0]?.[0]).toEqual(events[1]);
    expect(value.sandbox.executeRuntime).not.toHaveBeenCalled();
    expect(value.sources.materialize).not.toHaveBeenCalled();
  });
});
