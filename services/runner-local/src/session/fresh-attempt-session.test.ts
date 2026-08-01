import {
  runnerExecutionV1Schema,
  type RunnerTaskHeartbeatResponseV1,
} from "@socrates/contracts";
import {
  encodeRuntimeMessage,
  runtimeFrameSchema,
  runtimeProtocolLimits,
  type RuntimeFrame,
} from "@socrates/runtime-protocol";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { issueAdmittedSandboxImage } from "../image/capability";
import type { SandboxExecutionResult } from "../oci/backend";
import { issueMaterializedRuntimeRequest } from "../request/capability";
import { issueMaterializedSourceSnapshot } from "../source/capability";
import { LocalEventSpool } from "../spool/store";
import type { LeaseAuthorityScheduler } from "../supervision/lease-authority-monitor";
import { RunnerTransportError } from "../transport/client";
import { SequentialSpoolSender } from "../transport/sender";
import { WorkCompletionCoordinator } from "../work-journal/completion-coordinator";
import type { WorkJournalState } from "../work-journal/contracts";
import { LocalWorkJournal } from "../work-journal/store";
import { TerminalEvidenceRecoveryCoordinator } from "../work-journal/terminal-evidence-recovery";
import { attemptKeyFor } from "../spool/codec";
import {
  FreshAttemptSession,
  FreshAttemptSessionError,
} from "./fresh-attempt-session";
import taskFixture from "../../../../packages/contracts/fixtures/runner/task-v2.json";
import { issueVerifiedArtifact } from "../../../../packages/artifact-store/src/verification";

const deliveryId = "40000000-0000-4000-8000-000000000004";
const roots: string[] = [];
const execution = runnerExecutionV1Schema.parse({
  version: "1",
  lease: {
    version: "1",
    runnerId: "10000000-0000-4000-8000-000000000001",
    taskId: taskFixture.taskId,
    attemptId: "20000000-0000-4000-8000-000000000002",
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

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function durableRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "socrates-fresh-session-"));
  roots.push(path);
  return path;
}

async function openJournal(path: string): Promise<LocalWorkJournal> {
  return LocalWorkJournal.open({
    rootPath: join(path, "journal"),
    limits: {
      maximumManifestBytes: 10_000,
      maximumClaimBytes: 1_000_000,
      maximumItems: 10,
      maximumJournalBytes: 10_000_000,
    },
    identitySource: {
      attemptId: () => execution.lease.attemptId,
      now: () => new Date("2026-08-01T00:00:00.000Z"),
    },
    directorySync: { sync: async () => undefined },
  });
}

async function openSpool(
  path: string,
  eventId: () => string,
): Promise<LocalEventSpool> {
  return LocalEventSpool.open({
    rootPath: join(path, "spool"),
    limits: {
      maximumSegmentBytes: 1_000_000,
      maximumEventsPerSegment: 100,
      maximumAttempts: 10,
      maximumSpoolBytes: 10_000_000,
    },
    identitySource: {
      eventId,
      now: () => new Date("2026-08-01T00:00:01.000Z"),
    },
    directorySync: { sync: async () => undefined },
  });
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

function framed(values: RuntimeFrame[]): Uint8Array {
  const messages = values.map((frame) =>
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

function runtimeOutcome(): SandboxExecutionResult {
  return Object.freeze({
    exitCode: 0,
    stdout: "",
    stderr: "",
    stdoutBytes: framed(frames()),
    stderrBytes: new Uint8Array(),
    durationMs: 9,
  });
}

function work(state: "claimed" | "execution_started" | "completed") {
  const base: WorkJournalState = {
    deliveryId,
    taskId: execution.lease.taskId,
    attemptId: execution.lease.attemptId,
    state,
    admittedAt: "2026-08-01T00:00:00.000Z",
    claimedAt: "2026-08-01T00:00:01.000Z",
    ...(state !== "claimed"
      ? { executionStartedAt: "2026-08-01T00:00:02.000Z" }
      : {}),
    ...(state === "completed"
      ? {
          completedAt: "2026-08-01T00:00:03.000Z",
          completion: {
            attemptKey: attemptKeyFor(execution),
            acknowledgedSequence: 6,
          },
        }
      : {}),
  };
  return Object.freeze(base);
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

type HeartbeatStep =
  | RunnerTaskHeartbeatResponseV1
  | Error
  | (() => Promise<RunnerTaskHeartbeatResponseV1>);

function continued(): RunnerTaskHeartbeatResponseV1 {
  return {
    version: "1",
    leaseExpiresAt: "2026-08-01T02:00:30.000Z",
    directive: "continue",
  };
}

function harness(
  options: {
    heartbeats?: HeartbeatStep[];
    time?: () => number;
    commitStart?: () => Promise<WorkJournalState>;
    executeRuntime?: () => Promise<SandboxExecutionResult>;
    maximumRecoveryAttempts?: number;
    recovered?: boolean;
    append?: () => Promise<unknown>;
    recover?: (
      appended: boolean,
      currentWork: WorkJournalState,
    ) => Promise<
      | Readonly<{ state: "none" }>
      | Readonly<{ state: "completed"; work: WorkJournalState }>
    >;
  } = {},
) {
  const order: string[] = [];
  const heartbeatSteps = [...(options.heartbeats ?? [])];
  let currentWork = work("claimed");
  let appended = false;
  let clock = 10;
  const scheduler = new SignalScheduler();
  const heartbeat = vi.fn(async () => {
    order.push("heartbeat");
    const step = heartbeatSteps.shift() ?? continued();
    if (step instanceof Error) throw step;
    if (typeof step === "function") return step();
    return step;
  });
  const cancel = vi.fn(async () => {
    order.push("cancel");
    return Object.freeze({ state: "terminated" as const, forced: true });
  });
  const executeRuntime = vi.fn(
    options.executeRuntime ??
      (async () => {
        order.push("runtime");
        return runtimeOutcome();
      }),
  );
  const commitExecutionStart = vi.fn(
    options.commitStart ??
      (async () => {
        order.push("start");
        currentWork = work("execution_started");
        return currentWork;
      }),
  );
  const artifact = issueVerifiedArtifact(execution.task.source.digest, 128);
  const image = issueAdmittedSandboxImage({
    reference: execution.task.environment.imageDigest,
    localName: "trusted@digest",
    digest: execution.task.environment.imageDigest,
    configurationDigest: `sha256:${"d".repeat(64)}`,
    architecture: execution.task.environment.architecture,
    runtime: { executable: "/runtime", arguments: [] },
    profileProbe: { executable: "/probe", arguments: [] },
  });
  const resolve = vi.fn(async () => {
    order.push("artifact");
    return artifact;
  });
  const admit = vi.fn(async () => {
    order.push("image");
    return image;
  });
  const releaseSource = vi.fn(async () => {
    order.push("source.release");
  });
  const materializeSource = vi.fn(async ({ identity }) => {
    order.push("source");
    return issueMaterializedSourceSnapshot({
      path: "/private/source",
      deploymentId: "test",
      identity,
      digest: execution.task.source.digest,
      archiveBytes: 128,
      expandedBytes: 256,
      entryCount: 1,
    });
  });
  const releaseRequest = vi.fn(async () => {
    order.push("request.release");
  });
  const materializeRequest = vi.fn(async ({ bytes, identity }) => {
    order.push("request");
    return issueMaterializedRuntimeRequest({
      path: "/private/request",
      deploymentId: "test",
      identity,
      digest: `sha256:${"b".repeat(64)}`,
      sizeBytes: bytes.byteLength,
    });
  });
  const append = vi.fn(async () => {
    order.push("append");
    if (options.append) await options.append();
    appended = true;
    currentWork = work("completed");
    return [];
  });
  const recover = vi.fn(async () => {
    order.push("recover");
    if (options.recover) return options.recover(appended, currentWork);
    return appended
      ? Object.freeze({ state: "completed" as const, work: currentWork })
      : Object.freeze({ state: "none" as const });
  });
  const inspect = vi.fn(async () => currentWork);
  const claimedExecution = vi.fn(async () => execution);
  const inspectExisting = vi.fn(async () => null);
  const sessionOptions = {
    admission: {
      state: "ready",
      deliveryId,
      execution,
      recovered: options.recovered ?? false,
    },
    controlPlane: { heartbeat },
    scheduler,
    sandbox: { cancel, executeRuntime },
    journal: { commitExecutionStart, inspect, claimedExecution },
    artifacts: { resolve },
    images: { admit },
    sources: { materialize: materializeSource, release: releaseSource },
    requests: { materialize: materializeRequest, release: releaseRequest },
    spool: { append, inspectExisting },
    recovery: { recover },
    executionPolicy,
    time: {
      now:
        options.time ??
        (() => {
          const result = clock;
          clock += 3;
          return result;
        }),
    },
    runtime: {
      maximumProtocolBytes: 512 * 1_024,
      maximumChildOutputBytes: 2 * mebibyte,
    },
    leaseDurationMs: 30_000,
    heartbeatIntervalMs: 10_000,
    revocationGracePeriodMs: 0,
    maximumRecoveryAttempts: options.maximumRecoveryAttempts ?? 1,
  } satisfies ConstructorParameters<typeof FreshAttemptSession>[0];
  const session = new FreshAttemptSession(sessionOptions);
  return {
    append,
    cancel,
    claimedExecution,
    commitExecutionStart,
    executeRuntime,
    heartbeat,
    inspect,
    inspectExisting,
    order,
    recover,
    releaseRequest,
    releaseSource,
    scheduler,
    session,
    sessionOptions,
  };
}

async function claimedJournal(path: string): Promise<LocalWorkJournal> {
  const journal = await openJournal(path);
  await journal.admit({
    version: "1",
    deliveryId,
    taskId: execution.lease.taskId,
  });
  await journal.commitClaim(deliveryId, execution);
  return journal;
}

describe("FreshAttemptSession", () => {
  it("starts authority first and owns execution through durable publication", async () => {
    const value = harness();

    await expect(value.session.settle()).resolves.toMatchObject({
      state: "completed",
      publication: { state: "completed", publication: "appended" },
      authority: { state: "stopped" },
    });
    expect(value.order[0]).toBe("heartbeat");
    expect(value.order).toEqual([
      "heartbeat",
      "artifact",
      "image",
      "source",
      "request",
      "start",
      "runtime",
      "request.release",
      "source.release",
      "heartbeat",
      "recover",
      "append",
      "recover",
    ]);
    expect(value.scheduler.waits).toHaveLength(2);
  });

  it("accepts a recovered ready handoff without changing fresh ownership", async () => {
    const value = harness({ recovered: true });

    await expect(value.session.settle()).resolves.toMatchObject({
      state: "completed",
      publication: { publication: "appended" },
      authority: { state: "stopped" },
    });
    expect(value.commitExecutionStart).toHaveBeenCalledWith(
      deliveryId,
      execution,
    );
    expect(value.append).toHaveBeenCalledOnce();
  });

  it("has no heartbeat, journal, runtime, or publication effect at construction", () => {
    const value = harness();

    expect(value.heartbeat).not.toHaveBeenCalled();
    expect(value.commitExecutionStart).not.toHaveBeenCalled();
    expect(value.executeRuntime).not.toHaveBeenCalled();
    expect(value.recover).not.toHaveBeenCalled();
    expect(value.append).not.toHaveBeenCalled();
    expect(value.scheduler.waits).toHaveLength(0);
  });

  it("single-flights concurrent and sequential settlement", async () => {
    const value = harness();
    const first = value.session.settle();
    const second = value.session.settle();

    expect(second).toBe(first);
    const result = await first;
    expect(await value.session.settle()).toBe(result);
    expect(value.heartbeat).toHaveBeenCalledTimes(2);
    expect(value.append).toHaveBeenCalledOnce();
  });

  it("releases without constructing a publication path when timing is uncertain", async () => {
    const clockFailure = new Error("private clock failure");
    const value = harness({
      time: () => {
        throw clockFailure;
      },
    });

    const result = await value.session.settle();
    expect(result).toEqual({
      state: "no_evidence",
      reason: "observation_uncertain",
      authority: {
        state: "released",
        reason: "terminal_evidence_unavailable",
      },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(value.append).not.toHaveBeenCalled();
    expect(value.recover).not.toHaveBeenCalled();
    expect(value.inspect).not.toHaveBeenCalled();
    expect(value.claimedExecution).not.toHaveBeenCalled();
  });

  it("releases without publication when durable start cannot be proven", async () => {
    const value = harness({
      commitStart: async () => Promise.reject(new Error("private journal")),
    });

    await expect(value.session.settle()).resolves.toMatchObject({
      state: "no_evidence",
      reason: "candidate_missing",
      authority: { state: "released" },
    });
    expect(value.executeRuntime).not.toHaveBeenCalled();
    expect(value.append).not.toHaveBeenCalled();
    expect(value.recover).not.toHaveBeenCalled();
    expect(value.releaseRequest).toHaveBeenCalledOnce();
    expect(value.releaseSource).toHaveBeenCalledOnce();
  });

  it("closes a pre-execution cancellation with the shared exact authority", async () => {
    const value = harness({
      heartbeats: [
        {
          version: "1",
          leaseExpiresAt: "2026-08-01T02:00:30.000Z",
          directive: "cancel",
          cancellation: {
            requestedAt: "2026-08-01T01:59:59.000Z",
            gracePeriodMs: 25,
            reason: "budget",
          },
        },
      ],
    });

    await expect(value.session.settle()).resolves.toMatchObject({
      state: "no_evidence",
      reason: "observation_conflict",
      authority: {
        state: "cancelled",
        cancellation: {
          runnerId: execution.lease.runnerId,
          taskId: execution.lease.taskId,
          attemptId: execution.lease.attemptId,
          fence: execution.lease.fence,
          gracePeriodMs: 25,
        },
        termination: { state: "terminated", forced: true },
      },
    });
    expect(value.cancel).toHaveBeenCalledOnce();
    expect(value.executeRuntime).not.toHaveBeenCalled();
    expect(value.append).not.toHaveBeenCalled();
  });

  it("publishes cancellation evidence when cancellation follows execution", async () => {
    const value = harness({
      heartbeats: [
        continued(),
        {
          version: "1",
          leaseExpiresAt: "2026-08-01T02:00:30.000Z",
          directive: "cancel",
          cancellation: {
            requestedAt: "2026-08-01T01:59:59.000Z",
            gracePeriodMs: 25,
            reason: "operator",
          },
        },
      ],
    });

    await expect(value.session.settle()).resolves.toMatchObject({
      state: "completed",
      authority: { state: "cancelled" },
    });
    expect(value.append).toHaveBeenCalledOnce();
    const drafts = value.append.mock.calls[0]?.[1];
    expect(drafts?.at(-1)?.type).toBe("task.cancelled");
    expect(value.cancel).toHaveBeenCalledOnce();
  });

  it("reuses already recovered terminal evidence without appending", async () => {
    const completed = work("completed");
    const value = harness({
      recover: async () => ({ state: "completed", work: completed }),
    });

    await expect(value.session.settle()).resolves.toMatchObject({
      state: "completed",
      publication: { state: "completed", publication: "recovered" },
      authority: { state: "stopped" },
    });
    expect(value.recover).toHaveBeenCalledOnce();
    expect(value.append).not.toHaveBeenCalled();
  });

  it("awaits abandonment when append failure has no retained evidence", async () => {
    const privateFailure = new Error("private append failure");
    const value = harness({
      append: async () => Promise.reject(privateFailure),
    });

    await expect(value.session.settle()).rejects.toMatchObject({
      name: "TerminalPublicationOwnerError",
      code: "publication_abandoned",
      authority: {
        state: "abandoned",
        reason: "terminal_publication_failed",
      },
    });
    expect(value.append).toHaveBeenCalledOnce();
    expect(value.inspectExisting).toHaveBeenCalledOnce();
    expect(value.scheduler.waits.at(-1)?.signal.aborted).toBe(true);
  });

  it("suppresses completed local evidence after authenticated staleness", async () => {
    const stale = new RunnerTransportError("conflict", "stale", {
      status: 409,
      apiCode: "resource_conflict",
      requestId: "request-stale",
    });
    const value = harness({ heartbeats: [continued(), stale] });

    await expect(value.session.settle()).resolves.toEqual({
      state: "no_evidence",
      reason: "authority_lost",
      authority: { state: "stale" },
    });
    expect(value.cancel).toHaveBeenCalledOnce();
    expect(value.append).not.toHaveBeenCalled();
    expect(value.recover).not.toHaveBeenCalled();
  });

  it("rejects uncertain checkpoint settlement without publishing", async () => {
    const failure = new Error("private heartbeat outage");
    const value = harness({ heartbeats: [continued(), failure] });

    await expect(value.session.settle()).rejects.toMatchObject({
      name: "FreshAttemptSessionError",
      code: "authority_settlement_uncertain",
      message: "Fresh attempt authority settlement is uncertain.",
    });
    expect(value.cancel).toHaveBeenCalledOnce();
    expect(value.append).not.toHaveBeenCalled();
    expect(value.recover).not.toHaveBeenCalled();
  });

  it("persists, acknowledges, completes, and replays evidence through real stores", async () => {
    const path = await durableRoot();
    const journal = await claimedJournal(path);
    let event = 1;
    const spool = await openSpool(
      path,
      () =>
        `30000000-0000-4000-8000-${(event++).toString(16).padStart(12, "0")}`,
    );
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
    const recovery = new TerminalEvidenceRecoveryCoordinator(
      spool,
      new SequentialSpoolSender(spool, { submitEvent }),
      new WorkCompletionCoordinator(journal, spool),
    );
    const value = harness();
    const session = new FreshAttemptSession({
      ...value.sessionOptions,
      journal,
      spool,
      recovery,
    });

    await expect(session.settle()).resolves.toMatchObject({
      state: "completed",
      publication: {
        state: "completed",
        publication: "appended",
        work: { state: "completed" },
      },
      authority: { state: "stopped" },
    });
    expect(submitEvent).toHaveBeenCalledTimes(5);
    await expect(journal.inspect(deliveryId)).resolves.toMatchObject({
      state: "completed",
      completion: { acknowledgedSequence: 5 },
    });
    await expect(spool.inspectExisting(execution)).resolves.toMatchObject({
      terminal: true,
      acknowledgedSequence: 5,
      pendingEvents: 0,
    });

    const restartedJournal = await openJournal(path);
    const restartedSpool = await openSpool(path, () => {
      throw new Error("Completed replay must not allocate an event ID.");
    });
    const replaySubmit = vi.fn(async () => {
      throw new Error("Completed replay must not send an event.");
    });
    const restartedRecovery = new TerminalEvidenceRecoveryCoordinator(
      restartedSpool,
      new SequentialSpoolSender(restartedSpool, {
        submitEvent: replaySubmit,
      }),
      new WorkCompletionCoordinator(restartedJournal, restartedSpool),
    );
    await expect(
      restartedRecovery.recover(deliveryId, execution),
    ).resolves.toMatchObject({
      state: "completed",
      work: { state: "completed" },
    });
    expect(replaySubmit).not.toHaveBeenCalled();
  });

  it("keeps real durable stores event-free on no-evidence settlement", async () => {
    const path = await durableRoot();
    const journal = await claimedJournal(path);
    const eventId = vi.fn(() => "30000000-0000-4000-8000-000000000001");
    const spool = await openSpool(path, eventId);
    const recovery = new TerminalEvidenceRecoveryCoordinator(
      spool,
      new SequentialSpoolSender(spool, {
        submitEvent: vi.fn(async () => {
          throw new Error("No-evidence must not send an event.");
        }),
      }),
      new WorkCompletionCoordinator(journal, spool),
    );
    const value = harness({
      time: () => {
        throw new Error("private monotonic clock failure");
      },
    });
    const session = new FreshAttemptSession({
      ...value.sessionOptions,
      journal,
      spool,
      recovery,
    });

    await expect(session.settle()).resolves.toEqual({
      state: "no_evidence",
      reason: "observation_uncertain",
      authority: {
        state: "released",
        reason: "terminal_evidence_unavailable",
      },
    });
    expect(eventId).not.toHaveBeenCalled();
    await expect(spool.inspectExisting(execution)).resolves.toBeNull();
    const durable = await journal.inspect(deliveryId);
    expect(durable).toMatchObject({ state: "execution_started" });
    expect(durable).not.toHaveProperty("completion");
  });

  it.each([
    ["invalid state", { state: "claimed" }],
    ["invalid delivery", { deliveryId: "invalid" }],
    ["invalid recovery flag", { recovered: "yes" }],
    ["unknown field", { unknown: true }],
    [
      "identity drift",
      {
        execution: {
          ...execution,
          lease: {
            ...execution.lease,
            taskId: "50000000-0000-4000-8000-000000000005",
          },
        },
      },
    ],
  ])("rejects %s before effects", (_label, mutation) => {
    const value = harness();
    const candidate = {
      state: "ready",
      deliveryId,
      execution,
      recovered: true,
      ...mutation,
    };

    expect(
      () =>
        new FreshAttemptSession({
          ...value.sessionOptions,
          admission: candidate,
        } as never),
    ).toThrow(FreshAttemptSessionError);
    expect(value.heartbeat).not.toHaveBeenCalled();
    expect(value.commitExecutionStart).not.toHaveBeenCalled();
    expect(value.executeRuntime).not.toHaveBeenCalled();
    expect(value.append).not.toHaveBeenCalled();
  });

  it.each([-1, 1.5, 101, Number.MAX_SAFE_INTEGER + 1])(
    "validates recovery bound %s during construction",
    (maximumRecoveryAttempts) => {
      expect(() => harness({ maximumRecoveryAttempts })).toThrow(
        "maximumRecoveryAttempts must be a safe integer between 0 and 100.",
      );
    },
  );
});
