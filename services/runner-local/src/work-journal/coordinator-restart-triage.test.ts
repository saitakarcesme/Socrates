import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runnerExecutionV1Schema,
  type RunnerAttemptReconcileResponseV1,
  type RunnerAttemptRetirementReasonV1,
  type RunnerTaskDeliveryV1,
} from "@socrates/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runnerEventDraft } from "../lifecycle/draft";
import { attemptKeyFor } from "../spool";
import { LocalEventSpool } from "../spool/store";
import type { RunnerControlPlaneClient } from "../transport/client";
import { WorkCompletionCoordinator } from "./completion-coordinator";
import {
  WorkAdmissionCoordinator,
  type TerminalAdmissionEvidencePort,
} from "./coordinator";
import type { WorkJournalState } from "./contracts";
import { LocalWorkJournal } from "./store";
import { TerminalEvidenceRecoveryCoordinator } from "./terminal-evidence-recovery";
import { TerminalPublicationDispositionAuditor } from "./terminal-publication-disposition";
import type { TerminalPublicationDisposition } from "./terminal-publication-disposition";
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
    fence: 1,
    leasedUntil: "2026-07-31T18:00:00.000Z",
  },
  task: taskFixture,
});
const current = Object.freeze({
  version: "1" as const,
  state: "current" as const,
  observedAt: "2026-07-31T12:01:00.000Z",
  leaseExpiresAt: "2026-07-31T12:02:00.000Z",
});
const retirementReasons: readonly RunnerAttemptRetirementReasonV1[] = [
  "lease_expired_requeued",
  "lease_expired_failed",
  "lease_expired_cancelled",
  "attempt_terminal",
  "task_terminal",
  "fence_superseded",
];
const roots: string[] = [];

function root(): string {
  const value = join(
    tmpdir(),
    `socrates-restart-triage-${crypto.randomUUID().replaceAll("-", "")}`,
  );
  roots.push(value);
  return value;
}

async function openJournal(rootPath = root()): Promise<LocalWorkJournal> {
  return LocalWorkJournal.open({
    rootPath,
    limits: {
      maximumManifestBytes: 10_000,
      maximumClaimBytes: 1_000_000,
      maximumItems: 10,
      maximumJournalBytes: 10_000_000,
    },
    identitySource: {
      attemptId: () => attemptId,
      now: () => new Date("2026-07-31T12:00:00.000Z"),
    },
    directorySync: { sync: async () => undefined },
  });
}

async function activeJournal(state: "claimed" | "execution_started"): Promise<{
  journal: LocalWorkJournal;
  rootPath: string;
  work: WorkJournalState;
}> {
  const rootPath = root();
  const journal = await openJournal(rootPath);
  await journal.admit(delivery);
  await journal.commitClaim(delivery.deliveryId, execution);
  if (state === "execution_started") {
    await journal.commitExecutionStart(delivery.deliveryId, execution);
  }
  const work = await journal.inspect(delivery.deliveryId);
  if (!work) throw new Error("missing test work");
  return { journal, rootPath, work };
}

async function openSpool(rootPath: string): Promise<LocalEventSpool> {
  let nextEvent = 1;
  return LocalEventSpool.open({
    rootPath,
    limits: {
      maximumSegmentBytes: 1_000_000,
      maximumEventsPerSegment: 100,
      maximumAttempts: 10,
      maximumSpoolBytes: 10_000_000,
    },
    identitySource: {
      eventId: () =>
        `30000000-0000-4000-8000-${(nextEvent++).toString(16).padStart(12, "0")}`,
      now: () => new Date("2026-07-31T12:00:00.000Z"),
    },
    directorySync: { sync: async () => undefined },
  });
}

const terminalDrafts = Object.freeze([
  runnerEventDraft({
    type: "action.started",
    payload: { commandIndex: 0 },
  }),
  runnerEventDraft({
    type: "task.failed",
    payload: {
      classification: "infrastructure",
      message: "Fixed restart triage failure.",
    },
  }),
]);

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
    receivedAt: "2026-07-31T12:00:01.000Z",
  };
}

function completedWork(
  work: WorkJournalState,
  acknowledgedSequence = 2,
): WorkJournalState {
  return {
    ...work,
    state: "completed",
    completedAt: "2026-07-31T12:00:03.000Z",
    completion: {
      attemptKey: attemptKeyFor(execution),
      acknowledgedSequence,
    },
  };
}

function disposition(
  state: "absent" | "pending" | "acknowledged" | "completed",
  work: WorkJournalState,
): TerminalPublicationDisposition {
  if (state === "absent") return { state, work };
  if (state === "pending") {
    return {
      state,
      work,
      acknowledgedSequence: 1,
      lastSequence: 2,
      pendingEvents: 1,
    };
  }
  return {
    state,
    work,
    acknowledgedSequence: 2,
    lastSequence: 2,
    pendingEvents: 0,
  };
}

function controlPlane(options: {
  reconcile?: () => Promise<RunnerAttemptReconcileResponseV1>;
  acquire?: () => Promise<RunnerTaskDeliveryV1 | null>;
}): RunnerControlPlaneClient {
  return {
    acquireTaskDelivery: options.acquire ?? vi.fn().mockResolvedValue(null),
    reconcileAttempt: options.reconcile ?? vi.fn().mockResolvedValue(current),
  } as RunnerControlPlaneClient;
}

function coordinator(options: {
  journal: LocalWorkJournal;
  terminalEvidence: TerminalAdmissionEvidencePort;
  reconcile?: () => Promise<RunnerAttemptReconcileResponseV1>;
  acquire?: () => Promise<RunnerTaskDeliveryV1 | null>;
}): WorkAdmissionCoordinator {
  return new WorkAdmissionCoordinator({
    journal: options.journal,
    client: controlPlane(options),
    leaseDurationMs: 60_000,
    terminalEvidence: options.terminalEvidence,
  });
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("WorkAdmissionCoordinator restart terminal-evidence triage", () => {
  it.each(["claimed", "execution_started"] as const)(
    "returns audited completed %s work without recovery or reconciliation",
    async (state) => {
      const { journal, work } = await activeJournal(state);
      const completed = completedWork(work);
      const audit = vi
        .fn()
        .mockResolvedValue(disposition("completed", completed));
      const recover = vi.fn();
      const reconcile = vi.fn();
      const acquire = vi.fn();

      await expect(
        coordinator({
          journal,
          terminalEvidence: { audit, recover },
          reconcile,
          acquire,
        }).prepareNext(),
      ).resolves.toEqual({
        state: "completed",
        execution,
        work: completed,
        recovered: true,
      });
      expect(audit).toHaveBeenCalledWith(delivery.deliveryId, execution);
      expect(recover).not.toHaveBeenCalled();
      expect(reconcile).not.toHaveBeenCalled();
      expect(acquire).not.toHaveBeenCalled();
    },
  );

  it.each(["claimed", "execution_started"] as const)(
    "completes acknowledged %s work locally before reconciliation",
    async (state) => {
      const { journal, work } = await activeJournal(state);
      const completed = completedWork(work);
      const order: string[] = [];
      const audit = vi.fn(async () => {
        order.push("audit");
        return disposition("acknowledged", work);
      });
      const recover = vi.fn(async () => {
        order.push("recover");
        return { state: "completed" as const, work: completed };
      });
      const reconcile = vi.fn(async () => {
        order.push("reconcile");
        return current;
      });

      await expect(
        coordinator({
          journal,
          terminalEvidence: { audit, recover },
          reconcile,
        }).prepareNext(),
      ).resolves.toMatchObject({ state: "completed", work: completed });
      expect(order).toEqual(["audit", "recover"]);
      expect(reconcile).not.toHaveBeenCalled();
    },
  );

  it.each(["claimed", "execution_started"] as const)(
    "hands current pending %s work off without replay",
    async (state) => {
      const { journal, work } = await activeJournal(state);
      const mutableWork = structuredClone(work);
      const audit = vi
        .fn()
        .mockResolvedValue(disposition("pending", mutableWork));
      const recover = vi.fn();
      const reconcile = vi.fn().mockResolvedValue(current);
      const result = await coordinator({
        journal,
        terminalEvidence: { audit, recover },
        reconcile,
      }).prepareNext();

      expect(result).toEqual({
        state: "recovery_pending",
        deliveryId: delivery.deliveryId,
        execution,
        work,
        recovered: true,
        observedAt: current.observedAt,
        leaseExpiresAt: current.leaseExpiresAt,
      });
      expect(recover).not.toHaveBeenCalled();
      expect(reconcile).toHaveBeenCalledWith(
        {
          taskId: execution.lease.taskId,
          attemptId: execution.lease.attemptId,
          request: { version: "1", fence: execution.lease.fence },
        },
        undefined,
      );
      expect(Object.isFrozen(result)).toBe(true);
      if (result.state !== "recovery_pending")
        throw new Error("invalid result");
      expect(Object.isFrozen(result.work)).toBe(true);
      expect(Object.isFrozen(result.execution.task)).toBe(true);
      mutableWork.taskId = crypto.randomUUID();
      expect(result.work.taskId).toBe(delivery.taskId);
    },
  );

  it("reconciles absent claimed work before releasing it as ready", async () => {
    const { journal, work } = await activeJournal("claimed");
    const order: string[] = [];
    const recover = vi.fn();
    const result = await coordinator({
      journal,
      terminalEvidence: {
        audit: async () => {
          order.push("audit");
          return disposition("absent", work);
        },
        recover,
      },
      reconcile: async () => {
        order.push("reconcile");
        return current;
      },
    }).prepareNext();

    expect(result).toEqual({
      state: "ready",
      deliveryId: delivery.deliveryId,
      execution,
      recovered: true,
    });
    expect(order).toEqual(["audit", "reconcile"]);
    expect(recover).not.toHaveBeenCalled();
  });

  it("keeps absent execution-started work indeterminate when current", async () => {
    const { journal, work } = await activeJournal("execution_started");
    await expect(
      coordinator({
        journal,
        terminalEvidence: {
          audit: async () => disposition("absent", work),
          recover: vi.fn(),
        },
      }).prepareNext(),
    ).resolves.toEqual({
      state: "indeterminate",
      execution,
      work,
      recovered: true,
      observedAt: current.observedAt,
      leaseExpiresAt: current.leaseExpiresAt,
    });
  });

  it.each(
    (["claimed", "execution_started"] as const).flatMap((workState) =>
      (["absent", "pending"] as const).flatMap((terminalState) =>
        retirementReasons.map(
          (reason) => [workState, terminalState, reason] as const,
        ),
      ),
    ),
  )(
    "retires %s/%s work for authoritative %s without replay",
    async (workState, terminalState, reason) => {
      const { journal, rootPath, work } = await activeJournal(workState);
      const recover = vi.fn();
      const result = await coordinator({
        journal,
        terminalEvidence: {
          audit: async () => disposition(terminalState, work),
          recover,
        },
        reconcile: vi.fn().mockResolvedValue({
          version: "1",
          state: "retired",
          observedAt: "2026-07-31T12:03:00.000Z",
          reason,
        }),
      }).prepareNext();

      expect(result).toMatchObject({
        state: "retired",
        work: { state: "retired", retirement: { reason } },
      });
      expect(recover).not.toHaveBeenCalled();
      await expect(journal.inspect(delivery.deliveryId)).resolves.toMatchObject(
        {
          state: "retired",
          retirement: { reason },
        },
      );
      await expect(
        (await openJournal(rootPath)).inspect(delivery.deliveryId),
      ).resolves.toMatchObject({
        state: "retired",
        retirement: { reason },
      });
    },
  );

  it("preserves audit and reconciliation failures without acquiring", async () => {
    const auditFailure = new Error("audit unavailable");
    const first = await activeJournal("claimed");
    const acquireAfterAudit = vi.fn();
    await expect(
      coordinator({
        journal: first.journal,
        terminalEvidence: {
          audit: vi.fn().mockRejectedValue(auditFailure),
          recover: vi.fn(),
        },
        acquire: acquireAfterAudit,
      }).prepareNext(),
    ).rejects.toBe(auditFailure);
    expect(acquireAfterAudit).not.toHaveBeenCalled();

    const reconcileFailure = new Error("reconcile unavailable");
    const second = await activeJournal("execution_started");
    const acquireAfterReconcile = vi.fn();
    await expect(
      coordinator({
        journal: second.journal,
        terminalEvidence: {
          audit: async () => disposition("pending", second.work),
          recover: vi.fn(),
        },
        reconcile: vi.fn().mockRejectedValue(reconcileFailure),
        acquire: acquireAfterReconcile,
      }).prepareNext(),
    ).rejects.toBe(reconcileFailure);
    expect(acquireAfterReconcile).not.toHaveBeenCalled();
  });

  it("fails closed when acknowledged recovery is absent or inconsistent", async () => {
    const none = await activeJournal("claimed");
    await expect(
      coordinator({
        journal: none.journal,
        terminalEvidence: {
          audit: async () => disposition("acknowledged", none.work),
          recover: async () => ({ state: "none" }),
        },
      }).prepareNext(),
    ).rejects.toMatchObject({ code: "terminal_recovery_inconsistent" });

    const drift = await activeJournal("execution_started");
    await expect(
      coordinator({
        journal: drift.journal,
        terminalEvidence: {
          audit: async () => disposition("acknowledged", drift.work),
          recover: async () => ({
            state: "completed",
            work: {
              ...completedWork(drift.work),
              taskId: crypto.randomUUID(),
            },
          }),
        },
      }).prepareNext(),
    ).rejects.toMatchObject({ code: "terminal_recovery_inconsistent" });
  });

  it.each([
    ["identity drift", { taskId: crypto.randomUUID() }],
    ["state drift", { state: "execution_started" as const }],
  ])("fails closed on disposition work %s", async (_name, change) => {
    const { journal, work } = await activeJournal("claimed");
    await expect(
      coordinator({
        journal,
        terminalEvidence: {
          audit: async () =>
            disposition("absent", { ...work, ...change } as WorkJournalState),
          recover: vi.fn(),
        },
      }).prepareNext(),
    ).rejects.toMatchObject({ code: "terminal_recovery_inconsistent" });
  });

  it("fails closed on malformed disposition counters", async () => {
    const { journal, work } = await activeJournal("claimed");
    await expect(
      coordinator({
        journal,
        terminalEvidence: {
          audit: async () => ({
            state: "pending",
            work,
            acknowledgedSequence: 2,
            lastSequence: 2,
            pendingEvents: 1,
          }),
          recover: vi.fn(),
        },
      }).prepareNext(),
    ).rejects.toMatchObject({ code: "terminal_recovery_inconsistent" });
  });

  it("rejects durable execution identity drift before terminal audit", async () => {
    const { journal } = await activeJournal("claimed");
    vi.spyOn(journal, "claimedExecution").mockResolvedValue({
      ...execution,
      lease: { ...execution.lease, attemptId: crypto.randomUUID() },
    });
    const audit = vi.fn();
    await expect(
      coordinator({
        journal,
        terminalEvidence: { audit, recover: vi.fn() },
      }).prepareNext(),
    ).rejects.toMatchObject({ code: "terminal_recovery_inconsistent" });
    expect(audit).not.toHaveBeenCalled();
  });

  it("preserves a durable retirement failure and suppresses acquisition", async () => {
    const { journal, work } = await activeJournal("claimed");
    const failure = new Error("retirement publication failed");
    vi.spyOn(journal, "commitExecutionRetirement").mockRejectedValue(failure);
    const acquire = vi.fn();
    await expect(
      coordinator({
        journal,
        terminalEvidence: {
          audit: async () => disposition("pending", work),
          recover: vi.fn(),
        },
        reconcile: vi.fn().mockResolvedValue({
          version: "1",
          state: "retired",
          observedAt: "2026-07-31T12:03:00.000Z",
          reason: "fence_superseded",
        }),
        acquire,
      }).prepareNext(),
    ).rejects.toBe(failure);
    expect(acquire).not.toHaveBeenCalled();
  });

  it("completes acknowledged evidence locally through restarted durable stores", async () => {
    const path = root();
    const journalPath = join(path, "journal");
    const spoolPath = join(path, "spool");
    const journal = await openJournal(journalPath);
    await journal.admit(delivery);
    await journal.commitClaim(delivery.deliveryId, execution);
    await journal.commitExecutionStart(delivery.deliveryId, execution);
    const spool = await openSpool(spoolPath);
    const events = await spool.append(execution, terminalDrafts);
    for (const event of events) {
      await spool.acknowledge(execution, acknowledgement(event));
    }

    const restartedJournal = await openJournal(journalPath);
    const restartedSpool = await openSpool(spoolPath);
    const sendNext = vi.fn();
    const reconcile = vi.fn();
    const auditor = new TerminalPublicationDispositionAuditor(
      restartedJournal,
      restartedSpool,
    );
    const recovery = new TerminalEvidenceRecoveryCoordinator(
      restartedSpool,
      { sendNext },
      new WorkCompletionCoordinator(restartedJournal, restartedSpool),
    );
    const result = await coordinator({
      journal: restartedJournal,
      terminalEvidence: {
        audit: (deliveryId, candidate) => auditor.audit(deliveryId, candidate),
        recover: (deliveryId, candidate) =>
          recovery.recover(deliveryId, candidate),
      },
      reconcile,
    }).prepareNext();

    expect(result).toMatchObject({
      state: "completed",
      work: {
        state: "completed",
        completion: { acknowledgedSequence: events.length },
      },
    });
    expect(sendNext).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
    await expect(
      (await openJournal(journalPath)).inspect(delivery.deliveryId),
    ).resolves.toMatchObject({ state: "completed" });
  });

  it("hands pending durable evidence off without changing its restarted spool", async () => {
    const path = root();
    const journalPath = join(path, "journal");
    const spoolPath = join(path, "spool");
    const journal = await openJournal(journalPath);
    await journal.admit(delivery);
    await journal.commitClaim(delivery.deliveryId, execution);
    const spool = await openSpool(spoolPath);
    await spool.append(execution, terminalDrafts);

    const restartedJournal = await openJournal(journalPath);
    const restartedSpool = await openSpool(spoolPath);
    const before = await restartedSpool.inspectExisting(execution);
    const recover = vi.fn();
    const auditor = new TerminalPublicationDispositionAuditor(
      restartedJournal,
      restartedSpool,
    );
    await expect(
      coordinator({
        journal: restartedJournal,
        terminalEvidence: {
          audit: (deliveryId, candidate) =>
            auditor.audit(deliveryId, candidate),
          recover,
        },
      }).prepareNext(),
    ).resolves.toMatchObject({
      state: "recovery_pending",
      work: { state: "claimed" },
    });

    expect(recover).not.toHaveBeenCalled();
    await expect(restartedSpool.inspectExisting(execution)).resolves.toEqual(
      before,
    );
    await expect(
      restartedJournal.inspect(delivery.deliveryId),
    ).resolves.toMatchObject({ state: "claimed" });
  });
});
