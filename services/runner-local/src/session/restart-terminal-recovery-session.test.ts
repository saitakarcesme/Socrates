import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runnerExecutionV1Schema,
  type RunnerTaskDeliveryV1,
  type RunnerTaskHeartbeatResponseV1,
} from "@socrates/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runnerEventDraft } from "../lifecycle/draft";
import { attemptKeyFor, LocalEventSpool } from "../spool";
import type { SandboxTerminationReceipt } from "../oci/termination";
import { SequentialSpoolSender } from "../transport/sender";
import { RunnerTransportError } from "../transport/client";
import { WorkCompletionCoordinator } from "../work-journal/completion-coordinator";
import type { WorkJournalState } from "../work-journal/contracts";
import { LocalWorkJournal } from "../work-journal/store";
import { TerminalEvidenceRecoveryCoordinator } from "../work-journal/terminal-evidence-recovery";
import { TerminalEvidencePublicationStateUncertainError } from "../work-journal/terminal-evidence-publication";
import {
  TerminalPublicationDispositionAuditor,
  type TerminalPublicationDisposition,
} from "../work-journal/terminal-publication-disposition";
import { TerminalPublicationOwnerError } from "../work-journal/terminal-publication-owner";
import {
  RestartTerminalRecoverySession,
  RestartTerminalRecoverySessionError,
  type RecoveryPendingWorkAdmission,
} from "./restart-terminal-recovery-session";
import taskFixture from "../../../../packages/contracts/fixtures/runner/task-v2.json";

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
    fence: 11,
    leasedUntil: "2026-08-01T22:00:00.000Z",
  },
  task: taskFixture,
});
const roots: string[] = [];

function work(
  state: "claimed" | "execution_started" = "execution_started",
): WorkJournalState {
  return {
    deliveryId: delivery.deliveryId,
    taskId: delivery.taskId,
    attemptId,
    state,
    admittedAt: "2026-08-01T21:00:00.000Z",
    claimedAt: "2026-08-01T21:00:01.000Z",
    ...(state === "execution_started"
      ? { executionStartedAt: "2026-08-01T21:00:02.000Z" }
      : {}),
  };
}

function completed(
  baseline: WorkJournalState,
  acknowledgedSequence = 2,
): WorkJournalState {
  return {
    ...baseline,
    state: "completed",
    completedAt: "2026-08-01T21:00:03.000Z",
    completion: {
      attemptKey: attemptKeyFor(execution),
      acknowledgedSequence,
    },
  };
}

function disposition(
  state: "absent" | "pending" | "acknowledged" | "completed",
  baseline: WorkJournalState,
): TerminalPublicationDisposition {
  if (state === "absent") return { state, work: baseline };
  if (state === "pending") {
    return {
      state,
      work: baseline,
      acknowledgedSequence: 1,
      lastSequence: 2,
      pendingEvents: 1,
    };
  }
  return {
    state,
    work: state === "completed" ? completed(baseline) : baseline,
    acknowledgedSequence: 2,
    lastSequence: 2,
    pendingEvents: 0,
  };
}

function handoff(baseline = work()): RecoveryPendingWorkAdmission {
  return {
    state: "recovery_pending",
    deliveryId: delivery.deliveryId,
    execution,
    work: baseline,
    recovered: true,
    observedAt: "2026-08-01T21:00:04.000Z",
    leaseExpiresAt: "2026-08-01T21:01:04.000Z",
  };
}

function renewed(): RunnerTaskHeartbeatResponseV1 {
  return {
    version: "1",
    directive: "continue",
    leaseExpiresAt: "2026-08-01T21:02:04.000Z",
  };
}

function abortAwareScheduler(order?: string[]) {
  return {
    wait: vi.fn(async (_delayMs: number, signal: AbortSignal) => {
      order?.push("wait");
      await new Promise<void>((_resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    }),
  };
}

function fixture(options: {
  admission?: RecoveryPendingWorkAdmission;
  heartbeat?: () => Promise<RunnerTaskHeartbeatResponseV1>;
  audit: () => Promise<TerminalPublicationDisposition>;
  recover: () => Promise<
    { state: "none" } | { state: "completed"; work: WorkJournalState }
  >;
  maximumRecoveryAttempts?: number;
  order?: string[];
}) {
  const heartbeat = vi.fn(
    options.heartbeat ??
      (async () => {
        options.order?.push("heartbeat");
        return renewed();
      }),
  );
  const cancel = vi.fn(async (): Promise<SandboxTerminationReceipt> => ({
    state: "absent",
  }));
  const scheduler = abortAwareScheduler(options.order);
  const audit = vi.fn(options.audit);
  const recover = vi.fn(options.recover);
  return {
    audit,
    cancel,
    heartbeat,
    recover,
    scheduler,
    value: new RestartTerminalRecoverySession({
      admission: options.admission ?? handoff(),
      controlPlane: { heartbeat },
      sandbox: { cancel },
      scheduler,
      auditor: { audit },
      recovery: { recover },
      leaseDurationMs: 30_000,
      heartbeatIntervalMs: 10_000,
      revocationGracePeriodMs: 1_000,
      maximumRecoveryAttempts: options.maximumRecoveryAttempts ?? 1,
    }),
  };
}

function path(): string {
  const value = join(
    tmpdir(),
    `socrates-restart-session-${crypto.randomUUID().replaceAll("-", "")}`,
  );
  roots.push(value);
  return value;
}

async function openJournal(rootPath: string): Promise<LocalWorkJournal> {
  return LocalWorkJournal.open({
    rootPath: join(rootPath, "journal"),
    limits: {
      maximumManifestBytes: 10_000,
      maximumClaimBytes: 1_000_000,
      maximumItems: 10,
      maximumJournalBytes: 10_000_000,
    },
    identitySource: {
      attemptId: () => attemptId,
      now: () => new Date("2026-08-01T21:00:00.000Z"),
    },
    directorySync: { sync: async () => undefined },
  });
}

async function openSpool(rootPath: string): Promise<LocalEventSpool> {
  let next = 1;
  return LocalEventSpool.open({
    rootPath: join(rootPath, "spool"),
    limits: {
      maximumSegmentBytes: 1_000_000,
      maximumEventsPerSegment: 100,
      maximumAttempts: 10,
      maximumSpoolBytes: 10_000_000,
    },
    identitySource: {
      eventId: () =>
        `30000000-0000-4000-8000-${(next++).toString(16).padStart(12, "0")}`,
      now: () => new Date("2026-08-01T21:00:00.000Z"),
    },
    directorySync: { sync: async () => undefined },
  });
}

function acknowledgement(event: {
  eventId: string;
  attemptId: string;
  sequence: number;
}) {
  return {
    version: "1" as const,
    eventId: event.eventId,
    attemptId: event.attemptId,
    acknowledgedSequence: event.sequence,
    expectedSequence: event.sequence + 1,
    receivedAt: "2026-08-01T21:00:05.000Z",
  };
}

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((rootPath) => rm(rootPath, { recursive: true, force: true })),
  );
});

describe("RestartTerminalRecoverySession", () => {
  it("constructs a valid session without dependency effects", () => {
    const baseline = work();
    const value = fixture({
      admission: handoff(baseline),
      audit: async () => disposition("completed", baseline),
      recover: async () => ({ state: "none" }),
    });

    expect(value.heartbeat).not.toHaveBeenCalled();
    expect(value.scheduler.wait).not.toHaveBeenCalled();
    expect(value.audit).not.toHaveBeenCalled();
    expect(value.recover).not.toHaveBeenCalled();
    expect(value.cancel).not.toHaveBeenCalled();
  });

  it.each(["claimed", "execution_started"] as const)(
    "settles existing %s evidence and closes authority",
    async (state) => {
      const baseline = work(state);
      const audits = [
        disposition("pending", baseline),
        disposition("completed", baseline),
      ];
      const value = fixture({
        admission: handoff(baseline),
        audit: async () => audits.shift()!,
        recover: async () => ({
          state: "completed",
          work: completed(baseline),
        }),
      });

      await expect(value.value.settle()).resolves.toEqual({
        state: "completed",
        publication: {
          state: "completed",
          publication: "recovered",
          work: completed(baseline),
        },
        authority: { state: "stopped" },
      });
      expect(value.heartbeat).toHaveBeenCalledOnce();
      expect(value.scheduler.wait).toHaveBeenCalledOnce();
      expect(value.cancel).not.toHaveBeenCalled();
    },
  );

  it("starts the exact heartbeat before the first publication audit", async () => {
    const baseline = work();
    const order: string[] = [];
    const audits = [
      disposition("pending", baseline),
      disposition("completed", baseline),
    ];
    const value = fixture({
      admission: handoff(baseline),
      order,
      audit: async () => {
        order.push("audit");
        return audits.shift()!;
      },
      recover: async () => {
        order.push("recover");
        return { state: "completed", work: completed(baseline) };
      },
    });

    await value.value.settle();
    expect(order[0]).toBe("heartbeat");
    expect(order.indexOf("heartbeat")).toBeLessThan(order.indexOf("audit"));
    expect(value.heartbeat).toHaveBeenCalledWith(
      {
        taskId: execution.lease.taskId,
        attemptId: execution.lease.attemptId,
        request: {
          version: "1",
          fence: execution.lease.fence,
          leaseDurationMs: 30_000,
        },
      },
      undefined,
    );
    expect(value.audit).toHaveBeenCalledWith(delivery.deliveryId, execution);
    expect(value.recover).toHaveBeenCalledWith(delivery.deliveryId, execution);
  });

  it("waits for an in-flight heartbeat before fatal abandonment settles", async () => {
    const baseline = work();
    let release!: () => void;
    const heartbeatGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const value = fixture({
      admission: handoff(baseline),
      heartbeat: async () => {
        await heartbeatGate;
        return renewed();
      },
      audit: async () => disposition("absent", baseline),
      recover: async () => ({ state: "none" }),
    });
    let settled = false;
    const settlement = value.value.settle().finally(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(value.audit).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await expect(settlement).rejects.toMatchObject({
      code: "publication_abandoned",
      authority: { state: "abandoned" },
    });
    expect(value.scheduler.wait).not.toHaveBeenCalled();
  });

  it("checkpoints retained pending recovery before its exact retry", async () => {
    const baseline = work();
    const order: string[] = [];
    const audits = [
      disposition("pending", baseline),
      disposition("pending", baseline),
      disposition("pending", baseline),
      disposition("completed", baseline),
    ];
    let recoveries = 0;
    const value = fixture({
      admission: handoff(baseline),
      order,
      audit: async () => {
        order.push("audit");
        return audits.shift()!;
      },
      recover: async () => {
        order.push("recover");
        recoveries += 1;
        if (recoveries === 1) throw new Error("ambiguous pending delivery");
        return { state: "completed", work: completed(baseline) };
      },
    });

    await expect(value.value.settle()).resolves.toMatchObject({
      state: "completed",
      authority: { state: "stopped" },
    });
    expect(value.heartbeat).toHaveBeenCalledTimes(2);
    expect(value.recover).toHaveBeenCalledTimes(2);
    expect(order.filter((step) => step === "heartbeat")).toHaveLength(2);
    expect(order.indexOf("heartbeat", 1)).toBeLessThan(
      order.lastIndexOf("recover"),
    );
  });

  it("retries retained acknowledged recovery without another heartbeat", async () => {
    const baseline = work();
    const audits = [
      disposition("acknowledged", baseline),
      disposition("acknowledged", baseline),
      disposition("acknowledged", baseline),
      disposition("completed", baseline),
    ];
    let recoveries = 0;
    const value = fixture({
      admission: handoff(baseline),
      audit: async () => audits.shift()!,
      recover: async () => {
        recoveries += 1;
        if (recoveries === 1) throw new Error("local completion interrupted");
        return { state: "completed", work: completed(baseline) };
      },
    });

    await expect(value.value.settle()).resolves.toMatchObject({
      state: "completed",
      authority: { state: "stopped" },
    });
    expect(value.heartbeat).toHaveBeenCalledOnce();
    expect(value.recover).toHaveBeenCalledTimes(2);
  });

  it("returns matching authenticated cancellation after durable completion", async () => {
    const baseline = work();
    const cancellation = {
      version: "1" as const,
      directive: "cancel" as const,
      leaseExpiresAt: "2026-08-01T21:02:04.000Z",
      cancellation: {
        requestedAt: "2026-08-01T21:00:04.000Z",
        gracePeriodMs: 500,
        reason: "operator" as const,
      },
    };
    const value = fixture({
      admission: handoff(baseline),
      heartbeat: async () => cancellation,
      audit: async () => disposition("completed", baseline),
      recover: async () => ({ state: "none" }),
    });

    await expect(value.value.settle()).resolves.toMatchObject({
      state: "completed",
      authority: {
        state: "cancelled",
        cancellation: {
          runnerId: execution.lease.runnerId,
          taskId: execution.lease.taskId,
          attemptId: execution.lease.attemptId,
          fence: execution.lease.fence,
          reason: "operator",
        },
        termination: { state: "absent" },
      },
    });
    expect(value.recover).not.toHaveBeenCalled();
    expect(value.cancel).toHaveBeenCalledOnce();
  });

  it("observes stale authority before rejecting a retained pending retry", async () => {
    const baseline = work();
    const audits = [
      disposition("pending", baseline),
      disposition("pending", baseline),
    ];
    const value = fixture({
      admission: handoff(baseline),
      heartbeat: async () => {
        throw new RunnerTransportError("conflict", "private stale detail", {
          status: 409,
          apiCode: "resource_conflict",
          requestId: "request-1",
        });
      },
      audit: async () => audits.shift()!,
      recover: async () => {
        throw new Error("ambiguous delivery");
      },
    });

    await expect(value.value.settle()).rejects.toMatchObject<
      Partial<TerminalPublicationOwnerError>
    >({
      code: "authority_checkpoint_terminal",
      authority: { state: "stale" },
    });
    expect(value.cancel).toHaveBeenCalledWith(
      {
        runnerId: execution.lease.runnerId,
        taskId: execution.lease.taskId,
        attemptId: execution.lease.attemptId,
        fence: execution.lease.fence,
      },
      1_000,
    );
  });

  it("observes authenticated cancellation at a pending retry checkpoint", async () => {
    const baseline = work();
    const audits = [
      disposition("pending", baseline),
      disposition("pending", baseline),
    ];
    let heartbeats = 0;
    const value = fixture({
      admission: handoff(baseline),
      heartbeat: async () => {
        heartbeats += 1;
        if (heartbeats === 1) return renewed();
        return {
          version: "1",
          directive: "cancel",
          leaseExpiresAt: "2026-08-01T21:03:04.000Z",
          cancellation: {
            requestedAt: "2026-08-01T21:00:04.000Z",
            gracePeriodMs: 250,
            reason: "budget",
          },
        };
      },
      audit: async () => audits.shift()!,
      recover: async () => {
        throw new Error("retained pending evidence");
      },
    });

    await expect(value.value.settle()).rejects.toMatchObject<
      Partial<TerminalPublicationOwnerError>
    >({
      code: "authority_checkpoint_terminal",
      authority: {
        state: "cancelled",
        cancellation: { reason: "budget" },
        termination: { state: "absent" },
      },
    });
    expect(value.heartbeat).toHaveBeenCalledTimes(2);
    expect(value.cancel).toHaveBeenCalledOnce();
    expect(value.recover).toHaveBeenCalledOnce();
  });

  it("abandons authority when retained recovery is exhausted", async () => {
    const baseline = work();
    const audits = [
      disposition("pending", baseline),
      disposition("pending", baseline),
    ];
    const value = fixture({
      admission: handoff(baseline),
      audit: async () => audits.shift()!,
      recover: async () => {
        throw new Error("recovery remains ambiguous");
      },
      maximumRecoveryAttempts: 0,
    });

    await expect(value.value.settle()).rejects.toMatchObject<
      Partial<TerminalPublicationOwnerError>
    >({
      code: "recovery_exhausted",
      authority: {
        state: "abandoned",
        reason: "terminal_publication_failed",
      },
      disposition: { state: "pending" },
    });
    expect(value.heartbeat).toHaveBeenCalledOnce();
    expect(value.recover).toHaveBeenCalledOnce();
  });

  it("observes authority uncertainty and revocation before completion-release failure", async () => {
    const baseline = work();
    const secret = "token=private-monitor-detail";
    const value = fixture({
      admission: handoff(baseline),
      heartbeat: async () => {
        throw new Error(secret);
      },
      audit: async () => disposition("completed", baseline),
      recover: async () => ({ state: "none" }),
    });

    const failure = await value.value.settle().catch((error) => error);
    expect(failure).toBeInstanceOf(TerminalPublicationOwnerError);
    expect(failure).toMatchObject({ code: "completion_release_uncertain" });
    expect(failure.message).not.toContain(secret);
    expect(value.cancel).toHaveBeenCalledOnce();
  });

  it("fails closed when heartbeat protocol output is malformed", async () => {
    const baseline = work();
    const value = fixture({
      admission: handoff(baseline),
      heartbeat: async () =>
        ({
          version: "1",
          directive: "unknown",
        }) as RunnerTaskHeartbeatResponseV1,
      audit: async () => disposition("completed", baseline),
      recover: async () => ({ state: "none" }),
    });

    await expect(value.value.settle()).rejects.toMatchObject<
      Partial<TerminalPublicationOwnerError>
    >({ code: "completion_release_uncertain" });
    expect(value.cancel).toHaveBeenCalledOnce();
  });

  it("observes scheduler failure and local revocation before rejecting", async () => {
    const baseline = work();
    const cancel = vi.fn(async (): Promise<SandboxTerminationReceipt> => ({
      state: "absent",
    }));
    const schedulerFailure = new Error("private scheduler detail");
    const audit = vi.fn(async () => disposition("completed", baseline));
    const session = new RestartTerminalRecoverySession({
      admission: handoff(baseline),
      controlPlane: { heartbeat: vi.fn(async () => renewed()) },
      sandbox: { cancel },
      scheduler: {
        wait: vi.fn(async () => {
          throw schedulerFailure;
        }),
      },
      auditor: { audit },
      recovery: { recover: vi.fn(async () => ({ state: "none" as const })) },
      leaseDurationMs: 30_000,
      heartbeatIntervalMs: 10_000,
      revocationGracePeriodMs: 1_000,
      maximumRecoveryAttempts: 1,
    });

    const failure = await session.settle().catch((error) => error);
    expect(failure).toMatchObject({ code: "completion_release_uncertain" });
    expect(failure.message).not.toContain(schedulerFailure.message);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("retains authority and revocation failure causes only in memory", async () => {
    const baseline = work();
    const heartbeatFailure = new Error("private heartbeat failure");
    const revocationFailure = new Error("private revocation failure");
    const session = new RestartTerminalRecoverySession({
      admission: handoff(baseline),
      controlPlane: {
        heartbeat: vi.fn(async () => {
          throw heartbeatFailure;
        }),
      },
      sandbox: {
        cancel: vi.fn(async () => {
          throw revocationFailure;
        }),
      },
      scheduler: abortAwareScheduler(),
      auditor: {
        audit: vi.fn(async () => disposition("completed", baseline)),
      },
      recovery: { recover: vi.fn(async () => ({ state: "none" as const })) },
      leaseDurationMs: 30_000,
      heartbeatIntervalMs: 10_000,
      revocationGracePeriodMs: 1_000,
      maximumRecoveryAttempts: 1,
    });

    const failure = await session.settle().catch((error) => error);
    expect(failure).toMatchObject({ code: "completion_release_uncertain" });
    expect(failure.message).not.toContain("private");
    expect(failure.cause).toBeDefined();
  });

  it("abandons authority after fatal absent evidence", async () => {
    const baseline = work();
    const value = fixture({
      admission: handoff(baseline),
      audit: async () => disposition("absent", baseline),
      recover: async () => ({ state: "none" }),
    });

    await expect(value.value.settle()).rejects.toMatchObject<
      Partial<TerminalPublicationOwnerError>
    >({
      code: "publication_abandoned",
      authority: {
        state: "abandoned",
        reason: "terminal_publication_failed",
      },
    });
    expect(value.recover).not.toHaveBeenCalled();
    expect(value.heartbeat).toHaveBeenCalledOnce();
  });

  it("settles concurrent and sequential callers through one operation", async () => {
    const baseline = work();
    const value = fixture({
      admission: handoff(baseline),
      audit: async () => disposition("completed", baseline),
      recover: async () => ({ state: "none" }),
    });

    const first = value.value.settle();
    const second = value.value.settle();
    expect(second).toBe(first);
    const result = await first;
    expect(await value.value.settle()).toBe(result);
    expect(value.heartbeat).toHaveBeenCalledOnce();
    expect(value.audit).toHaveBeenCalledOnce();
  });

  it.each([
    ["null", null],
    ["wrong state", { ...handoff(), state: "ready" }],
    ["not recovered", { ...handoff(), recovered: false }],
    ["unknown field", { ...handoff(), unexpected: true }],
    ["bad observed timestamp", { ...handoff(), observedAt: "tomorrow" }],
    ["bad lease timestamp", { ...handoff(), leaseExpiresAt: "later" }],
    ["delivery drift", { ...handoff(), deliveryId: crypto.randomUUID() }],
    [
      "task drift",
      { ...handoff(), work: { ...work(), taskId: crypto.randomUUID() } },
    ],
    ["terminal work", { ...handoff(), work: completed(work()) }],
  ])("rejects malformed %s handoff before effects", (_name, admission) => {
    const heartbeat = vi.fn();
    const cancel = vi.fn();
    const audit = vi.fn();
    const recover = vi.fn();
    expect(
      () =>
        new RestartTerminalRecoverySession({
          admission: admission as RecoveryPendingWorkAdmission,
          controlPlane: { heartbeat },
          sandbox: { cancel },
          scheduler: abortAwareScheduler(),
          auditor: { audit },
          recovery: { recover },
          leaseDurationMs: 30_000,
          heartbeatIntervalMs: 10_000,
          revocationGracePeriodMs: 1_000,
          maximumRecoveryAttempts: 1,
        }),
    ).toThrow(
      expect.objectContaining<Partial<RestartTerminalRecoverySessionError>>({
        code: "invalid_handoff",
      }),
    );
    expect(heartbeat).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
  });

  it("snapshots mutable handoff identity before settlement", async () => {
    const baseline = work();
    const admission = structuredClone(handoff(baseline));
    const value = fixture({
      admission,
      audit: async () => disposition("completed", baseline),
      recover: async () => ({ state: "none" }),
    });
    admission.work.taskId = crypto.randomUUID();
    admission.execution.lease.attemptId = crypto.randomUUID();

    await expect(value.value.settle()).resolves.toMatchObject({
      publication: { work: { taskId: delivery.taskId, attemptId } },
    });
    expect(value.heartbeat).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: delivery.taskId,
        attemptId,
      }),
      undefined,
    );
  });

  it("propagates bounded configuration rejection without effects", () => {
    const heartbeat = vi.fn();
    const audit = vi.fn();
    expect(
      () =>
        new RestartTerminalRecoverySession({
          admission: handoff(),
          controlPlane: { heartbeat },
          sandbox: { cancel: vi.fn() },
          scheduler: abortAwareScheduler(),
          auditor: { audit },
          recovery: { recover: vi.fn() },
          leaseDurationMs: 30_000,
          heartbeatIntervalMs: 10_001,
          revocationGracePeriodMs: 1_000,
          maximumRecoveryAttempts: 1,
        }),
    ).toThrow(RangeError);
    expect(heartbeat).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("keeps publication uncertainty redacted while closing authority", async () => {
    const secret = "host=C:\\private\\runner";
    const value = fixture({
      audit: async () => {
        throw new Error(secret);
      },
      recover: async () => ({ state: "none" }),
    });

    const failure = await value.value.settle().catch((error) => error);
    expect(failure).toBeInstanceOf(TerminalPublicationOwnerError);
    expect(failure).toMatchObject({ code: "publication_abandoned" });
    expect(failure.message).not.toContain(secret);
    expect(failure.cause).toBeInstanceOf(
      TerminalEvidencePublicationStateUncertainError,
    );
  });

  it("drains a real restarted pending spool without appending", async () => {
    const rootPath = path();
    const journal = await openJournal(rootPath);
    await journal.admit(delivery);
    await journal.commitClaim(delivery.deliveryId, execution);
    await journal.commitExecutionStart(delivery.deliveryId, execution);
    const baseline = await journal.inspect(delivery.deliveryId);
    if (!baseline) throw new Error("missing test work");
    const spool = await openSpool(rootPath);
    const events = await spool.append(execution, [
      runnerEventDraft({
        type: "action.started",
        payload: { commandIndex: 0 },
      }),
      runnerEventDraft({
        type: "task.failed",
        payload: {
          classification: "infrastructure",
          message: "Fixed restart session test failure.",
        },
      }),
    ]);
    await spool.acknowledge(execution, acknowledgement(events[0]!));

    const restartedJournal = await openJournal(rootPath);
    const restartedSpool = await openSpool(rootPath);
    const submitEvent = vi.fn(async (event: (typeof events)[number]) => ({
      version: "1" as const,
      replay: false,
      acknowledgement: acknowledgement(event),
    }));
    const recovery = new TerminalEvidenceRecoveryCoordinator(
      restartedSpool,
      new SequentialSpoolSender(restartedSpool, { submitEvent }),
      new WorkCompletionCoordinator(restartedJournal, restartedSpool),
    );
    const heartbeat = vi.fn(async () => renewed());
    const session = new RestartTerminalRecoverySession({
      admission: handoff(baseline),
      controlPlane: { heartbeat },
      sandbox: { cancel: vi.fn(async () => ({ state: "absent" as const })) },
      scheduler: abortAwareScheduler(),
      auditor: new TerminalPublicationDispositionAuditor(
        restartedJournal,
        restartedSpool,
      ),
      recovery,
      leaseDurationMs: 30_000,
      heartbeatIntervalMs: 10_000,
      revocationGracePeriodMs: 1_000,
      maximumRecoveryAttempts: 1,
    });

    await expect(session.settle()).resolves.toMatchObject({
      state: "completed",
      publication: {
        publication: "recovered",
        work: { state: "completed" },
      },
      authority: { state: "stopped" },
    });
    expect(submitEvent).toHaveBeenCalledOnce();
    expect(submitEvent.mock.calls[0]?.[0]).toEqual(events[1]);
    await expect(restartedSpool.inspectExisting(execution)).resolves.toEqual({
      attemptKey: attemptKeyFor(execution),
      acknowledgedSequence: 2,
      lastSequence: 2,
      pendingEvents: 0,
      terminal: true,
    });
  }, 15_000);

  it("completes a real acknowledged spool locally without submitting an event", async () => {
    const rootPath = path();
    const journal = await openJournal(rootPath);
    await journal.admit(delivery);
    await journal.commitClaim(delivery.deliveryId, execution);
    const baseline = await journal.inspect(delivery.deliveryId);
    if (!baseline) throw new Error("missing test work");
    const spool = await openSpool(rootPath);
    const events = await spool.append(execution, [
      runnerEventDraft({
        type: "action.started",
        payload: { commandIndex: 0 },
      }),
      runnerEventDraft({
        type: "task.failed",
        payload: {
          classification: "infrastructure",
          message: "Fixed acknowledged restart session test failure.",
        },
      }),
    ]);
    for (const event of events) {
      await spool.acknowledge(execution, acknowledgement(event));
    }

    const restartedJournal = await openJournal(rootPath);
    const restartedSpool = await openSpool(rootPath);
    const sendNext = vi.fn();
    const session = new RestartTerminalRecoverySession({
      admission: handoff(baseline),
      controlPlane: { heartbeat: vi.fn(async () => renewed()) },
      sandbox: { cancel: vi.fn(async () => ({ state: "absent" as const })) },
      scheduler: abortAwareScheduler(),
      auditor: new TerminalPublicationDispositionAuditor(
        restartedJournal,
        restartedSpool,
      ),
      recovery: new TerminalEvidenceRecoveryCoordinator(
        restartedSpool,
        { sendNext },
        new WorkCompletionCoordinator(restartedJournal, restartedSpool),
      ),
      leaseDurationMs: 30_000,
      heartbeatIntervalMs: 10_000,
      revocationGracePeriodMs: 1_000,
      maximumRecoveryAttempts: 1,
    });

    await expect(session.settle()).resolves.toMatchObject({
      state: "completed",
      publication: { work: { state: "completed" } },
      authority: { state: "stopped" },
    });
    expect(sendNext).not.toHaveBeenCalled();
    await expect(restartedSpool.inspectExisting(execution)).resolves.toEqual({
      attemptKey: attemptKeyFor(execution),
      acknowledgedSequence: 2,
      lastSequence: 2,
      pendingEvents: 0,
      terminal: true,
    });
  }, 15_000);
});
