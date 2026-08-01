import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runnerExecutionV1Schema,
  type RunnerTaskDeliveryV1,
} from "@socrates/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runnerEventDraft } from "../lifecycle/draft";
import { attemptKeyFor, LocalEventSpool } from "../spool";
import { SequentialSpoolSender } from "../transport/sender";
import { WorkCompletionCoordinator } from "./completion-coordinator";
import type { WorkJournalState } from "./contracts";
import {
  RecoveryOnlyTerminalPublication,
  RecoveryOnlyTerminalPublicationError,
} from "./recovery-only-terminal-publication";
import { LocalWorkJournal } from "./store";
import {
  TerminalEvidencePublicationDeferredError,
  TerminalEvidencePublicationStateUncertainError,
} from "./terminal-evidence-publication";
import { TerminalEvidenceRecoveryCoordinator } from "./terminal-evidence-recovery";
import {
  TerminalPublicationDispositionAuditor,
  type TerminalPublicationDisposition,
} from "./terminal-publication-disposition";
import { TerminalPublicationOwner } from "./terminal-publication-owner";
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
    fence: 7,
    leasedUntil: "2026-08-01T20:00:00.000Z",
  },
  task: taskFixture,
});
const roots: string[] = [];

function work(
  state: "claimed" | "execution_started" = "claimed",
): WorkJournalState {
  return {
    deliveryId: delivery.deliveryId,
    taskId: delivery.taskId,
    attemptId,
    state,
    admittedAt: "2026-08-01T19:00:00.000Z",
    claimedAt: "2026-08-01T19:00:01.000Z",
    ...(state === "execution_started"
      ? { executionStartedAt: "2026-08-01T19:00:02.000Z" }
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
    completedAt: "2026-08-01T19:00:03.000Z",
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

function value(options: {
  baseline?: WorkJournalState;
  audit: () => Promise<TerminalPublicationDisposition>;
  recover: () => Promise<
    { state: "none" } | { state: "completed"; work: WorkJournalState }
  >;
}): RecoveryOnlyTerminalPublication {
  return new RecoveryOnlyTerminalPublication({
    work: options.baseline ?? work(),
    deliveryId: delivery.deliveryId,
    execution,
    auditor: { audit: options.audit },
    recovery: { recover: options.recover },
  });
}

function root(): string {
  const path = join(
    tmpdir(),
    `socrates-recovery-only-${crypto.randomUUID().replaceAll("-", "")}`,
  );
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
      attemptId: () => attemptId,
      now: () => new Date("2026-08-01T19:00:00.000Z"),
    },
    directorySync: { sync: async () => undefined },
  });
}

async function openSpool(path: string): Promise<LocalEventSpool> {
  let next = 1;
  return LocalEventSpool.open({
    rootPath: join(path, "spool"),
    limits: {
      maximumSegmentBytes: 1_000_000,
      maximumEventsPerSegment: 100,
      maximumAttempts: 10,
      maximumSpoolBytes: 10_000_000,
    },
    identitySource: {
      eventId: () =>
        `30000000-0000-4000-8000-${(next++).toString(16).padStart(12, "0")}`,
      now: () => new Date("2026-08-01T19:00:00.000Z"),
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
      message: "Fixed recovery-only test failure.",
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
    receivedAt: "2026-08-01T19:00:04.000Z",
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("RecoveryOnlyTerminalPublication", () => {
  it.each(["claimed", "execution_started"] as const)(
    "returns already completed %s evidence without probing recovery",
    async (state) => {
      const baseline = work(state);
      const recover = vi.fn();
      const publication = value({
        baseline,
        audit: vi.fn().mockResolvedValue(disposition("completed", baseline)),
        recover,
      });

      await expect(publication.publish()).resolves.toEqual({
        state: "completed",
        publication: "recovered",
        work: completed(baseline),
      });
      expect(recover).not.toHaveBeenCalled();
    },
  );

  it("rejects absent evidence before recovery", async () => {
    const baseline = work();
    const recover = vi.fn();
    await expect(
      value({
        baseline,
        audit: vi.fn().mockResolvedValue(disposition("absent", baseline)),
        recover,
      }).publish(),
    ).rejects.toMatchObject({ code: "recovery_evidence_missing" });
    expect(recover).not.toHaveBeenCalled();
  });

  it.each(["pending", "acknowledged"] as const)(
    "recovers and validates %s evidence in exact order",
    async (state) => {
      const baseline = work("execution_started");
      const order: string[] = [];
      const audits = [
        disposition(state, baseline),
        disposition("completed", baseline),
      ];
      const audit = vi.fn(async () => {
        order.push("audit");
        return audits.shift()!;
      });
      const recover = vi.fn(async () => {
        order.push("recover");
        return { state: "completed" as const, work: completed(baseline) };
      });

      await expect(
        value({ baseline, audit, recover }).publish(),
      ).resolves.toMatchObject({
        state: "completed",
        publication: "recovered",
      });
      expect(order).toEqual(["audit", "recover", "audit"]);
      expect(audit).toHaveBeenCalledWith(delivery.deliveryId, execution);
      expect(recover).toHaveBeenCalledWith(delivery.deliveryId, execution);
    },
  );

  it.each(["pending", "acknowledged"] as const)(
    "defers failed recovery with its post-failure %s disposition",
    async (state) => {
      const baseline = work();
      const primary = new Error("private transport detail");
      const publication = value({
        baseline,
        audit: vi
          .fn()
          .mockResolvedValueOnce(disposition("pending", baseline))
          .mockResolvedValueOnce(disposition(state, baseline)),
        recover: vi.fn().mockRejectedValue(primary),
      });

      const failure = await publication.publish().catch((error) => error);
      expect(failure).toBeInstanceOf(TerminalEvidencePublicationDeferredError);
      expect(failure).toMatchObject({
        code: "publication_deferred",
        boundary: "recovery_only",
        disposition: { state },
        cause: primary,
      });
    },
  );

  it("converts post-failure completed evidence into recovered success", async () => {
    const baseline = work();
    await expect(
      value({
        baseline,
        audit: vi
          .fn()
          .mockResolvedValueOnce(disposition("pending", baseline))
          .mockResolvedValueOnce(disposition("completed", baseline)),
        recover: vi.fn().mockRejectedValue(new Error("ambiguous delivery")),
      }).publish(),
    ).resolves.toEqual({
      state: "completed",
      publication: "recovered",
      work: completed(baseline),
    });
  });

  it("classifies absent post-failure evidence as missing", async () => {
    const baseline = work();
    const primary = new Error("ambiguous delivery");
    const failure = await value({
      baseline,
      audit: vi
        .fn()
        .mockResolvedValueOnce(disposition("pending", baseline))
        .mockResolvedValueOnce(disposition("absent", baseline)),
      recover: vi.fn().mockRejectedValue(primary),
    })
      .publish()
      .catch((error) => error);
    expect(failure).toMatchObject({
      code: "recovery_evidence_missing",
      cause: primary,
    });
  });

  it("preserves initial and post-failure audit uncertainty", async () => {
    const initialCause = new Error("initial audit failed");
    const initial = await value({
      audit: vi.fn().mockRejectedValue(initialCause),
      recover: vi.fn(),
    })
      .publish()
      .catch((error) => error);
    expect(initial).toBeInstanceOf(
      TerminalEvidencePublicationStateUncertainError,
    );
    expect(initial).toMatchObject({
      code: "publication_state_uncertain",
      boundary: "recovery_only",
      cause: initialCause,
    });

    const baseline = work();
    const primary = new Error("recovery failed");
    const auditCause = new Error("post audit failed");
    const post = await value({
      baseline,
      audit: vi
        .fn()
        .mockResolvedValueOnce(disposition("pending", baseline))
        .mockRejectedValueOnce(auditCause),
      recover: vi.fn().mockRejectedValue(primary),
    })
      .publish()
      .catch((error) => error);
    expect(post).toBeInstanceOf(TerminalEvidencePublicationStateUncertainError);
    expect(post).toMatchObject({ boundary: "recovery_only" });
    expect(post.cause).toBeInstanceOf(AggregateError);
    expect((post.cause as AggregateError).errors).toEqual([
      primary,
      auditCause,
    ]);
  });

  it.each([
    ["null", null],
    ["unknown state", { state: "other", work: work() }],
    [
      "invalid cursor",
      {
        state: "pending",
        work: work(),
        acknowledgedSequence: 2,
        lastSequence: 2,
        pendingEvents: 1,
      },
    ],
    ["unknown field", { ...disposition("absent", work()), unexpected: true }],
  ])(
    "treats malformed initial %s audit output as uncertain",
    async (_name, output) => {
      const recover = vi.fn();
      await expect(
        value({
          audit: vi.fn().mockResolvedValue(output),
          recover,
        }).publish(),
      ).rejects.toMatchObject({
        code: "publication_state_uncertain",
        boundary: "recovery_only",
      });
      expect(recover).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["none", { state: "none" }],
    ["unknown state", { state: "other" }],
    ["null", null],
  ])("fails closed on %s recovery output", async (_name, output) => {
    const baseline = work();
    await expect(
      value({
        baseline,
        audit: vi.fn().mockResolvedValue(disposition("pending", baseline)),
        recover: vi.fn().mockResolvedValue(output),
      }).publish(),
    ).rejects.toMatchObject({ code: "recovery_result_inconsistent" });
  });

  it.each([
    ["delivery", { deliveryId: crypto.randomUUID() }],
    ["task", { taskId: crypto.randomUUID() }],
    ["attempt", { attemptId: crypto.randomUUID() }],
    ["state", { state: "retired" }],
    ["acknowledgement", { completion: { acknowledgedSequence: 1 } }],
  ])("fails closed on completed recovery %s drift", async (_name, change) => {
    const baseline = work();
    const candidate = {
      ...completed(baseline),
      ...change,
    } as WorkJournalState;
    await expect(
      value({
        baseline,
        audit: vi.fn().mockResolvedValue(disposition("pending", baseline)),
        recover: vi.fn().mockResolvedValue({
          state: "completed",
          work: candidate,
        }),
      }).publish(),
    ).rejects.toMatchObject({ code: "recovery_result_inconsistent" });
  });

  it("fails closed when completed recovery contradicts the final audit", async () => {
    const baseline = work();
    await expect(
      value({
        baseline,
        audit: vi
          .fn()
          .mockResolvedValueOnce(disposition("pending", baseline))
          .mockResolvedValueOnce(disposition("acknowledged", baseline)),
        recover: vi.fn().mockResolvedValue({
          state: "completed",
          work: completed(baseline),
        }),
      }).publish(),
    ).rejects.toMatchObject({ code: "recovery_result_inconsistent" });
  });

  it.each([
    ["completed", { ...work(), state: "completed" }],
    ["retired", { ...work(), state: "retired" }],
    ["rejected", { ...work(), state: "rejected" }],
    ["pending", { ...work(), state: "pending_claim" }],
    ["identity", { ...work(), taskId: crypto.randomUUID() }],
  ])("rejects %s bound work before dependency calls", (_name, candidate) => {
    const audit = vi.fn();
    const recover = vi.fn();
    expect(
      () =>
        new RecoveryOnlyTerminalPublication({
          work: candidate as WorkJournalState,
          deliveryId: delivery.deliveryId,
          execution,
          auditor: { audit },
          recovery: { recover },
        }),
    ).toThrow(
      expect.objectContaining<Partial<RecoveryOnlyTerminalPublicationError>>({
        code: "invalid_input",
      }),
    );
    expect(audit).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
  });

  it("rejects mismatched delivery and execution constructor identity", () => {
    expect(
      () =>
        new RecoveryOnlyTerminalPublication({
          work: work(),
          deliveryId: crypto.randomUUID(),
          execution,
          auditor: { audit: vi.fn() },
          recovery: { recover: vi.fn() },
        }),
    ).toThrow(expect.objectContaining({ code: "invalid_input" }));
    expect(
      () =>
        new RecoveryOnlyTerminalPublication({
          work: work(),
          deliveryId: delivery.deliveryId,
          execution: {
            ...execution,
            lease: { ...execution.lease, attemptId: crypto.randomUUID() },
          },
          auditor: { audit: vi.fn() },
          recovery: { recover: vi.fn() },
        }),
    ).toThrow(expect.objectContaining({ code: "invalid_input" }));
  });

  it("rejects mutable disposition drift and returns deeply frozen evidence", async () => {
    const baseline = work("execution_started");
    const mutable = disposition("completed", baseline) as {
      state: "completed";
      work: WorkJournalState;
      acknowledgedSequence: number;
      lastSequence: number;
      pendingEvents: number;
    };
    const result = await value({
      baseline,
      audit: vi.fn().mockResolvedValue(mutable),
      recover: vi.fn(),
    }).publish();
    mutable.work = { ...mutable.work, taskId: crypto.randomUUID() };

    expect(result.work.taskId).toBe(delivery.taskId);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.work)).toBe(true);
    expect(Object.isFrozen(result.work.completion)).toBe(true);
  });

  it("serializes concurrent calls while remaining repeatable", async () => {
    const baseline = work();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const audit = vi
      .fn()
      .mockImplementationOnce(async () => {
        await gate;
        return disposition("completed", baseline);
      })
      .mockResolvedValue(disposition("completed", baseline));
    const publication = value({ baseline, audit, recover: vi.fn() });

    const first = publication.publish();
    const second = publication.publish();
    await vi.waitFor(() => expect(audit).toHaveBeenCalledOnce());
    release();
    const results = await Promise.all([first, second]);
    expect(audit).toHaveBeenCalledTimes(2);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).not.toBe(results[1]);
  });

  it.each([
    ["pending", 1],
    ["acknowledged", 0],
  ] as const)(
    "plugs into bounded ownership for retained %s recovery",
    async (state, expectedCheckpoints) => {
      const baseline = work();
      const order: string[] = [];
      const audits = [
        disposition(state, baseline),
        disposition(state, baseline),
        disposition(state, baseline),
        disposition("completed", baseline),
      ];
      const audit = vi.fn(async () => {
        order.push("audit");
        return audits.shift()!;
      });
      const recover = vi
        .fn()
        .mockImplementationOnce(async () => {
          order.push("recover");
          throw new Error("retained recovery");
        })
        .mockImplementationOnce(async () => {
          order.push("recover");
          return { state: "completed", work: completed(baseline) };
        });
      const publication = value({ baseline, audit, recover });
      const checkpoint = vi.fn(async () => {
        order.push("checkpoint");
        return {
          state: "renewed" as const,
          leaseExpiresAt: "2026-08-01T20:01:00.000Z",
        };
      });
      const stop = vi.fn(async () => {
        order.push("stop");
        return { state: "stopped" as const };
      });
      const abandonPublication = vi.fn();
      const owner = new TerminalPublicationOwner({
        authority: { checkpoint, stop, abandonPublication },
        maximumRecoveryAttempts: 1,
        publish: () => publication.publish(),
      });

      await expect(owner.complete()).resolves.toMatchObject({
        state: "completed",
        publication: { publication: "recovered" },
        authority: { state: "stopped" },
      });
      expect(checkpoint).toHaveBeenCalledTimes(expectedCheckpoints);
      expect(abandonPublication).not.toHaveBeenCalled();
      expect(order).toEqual([
        "audit",
        "recover",
        "audit",
        ...(state === "pending" ? ["checkpoint"] : []),
        "audit",
        "recover",
        "audit",
        "stop",
      ]);
    },
  );

  it("keeps dependency secrets out of fixed public messages", async () => {
    const secret = "token=private-host-path";
    const failure = await value({
      audit: vi.fn().mockRejectedValue(new Error(secret)),
      recover: vi.fn(),
    })
      .publish()
      .catch((error) => error);
    expect(failure.message).toBe(
      "Terminal evidence publication state is uncertain.",
    );
    expect(failure.message).not.toContain(secret);
  });

  it("drains only the existing pending durable spool after restart", async () => {
    const path = root();
    const journal = await openJournal(path);
    await journal.admit(delivery);
    await journal.commitClaim(delivery.deliveryId, execution);
    const baseline = await journal.inspect(delivery.deliveryId);
    if (!baseline) throw new Error("missing test work");
    const spool = await openSpool(path);
    const events = await spool.append(execution, terminalDrafts);
    await spool.acknowledge(execution, acknowledgement(events[0]!));

    const restartedJournal = await openJournal(path);
    const restartedSpool = await openSpool(path);
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
    const publication = new RecoveryOnlyTerminalPublication({
      work: baseline,
      deliveryId: delivery.deliveryId,
      execution,
      auditor: new TerminalPublicationDispositionAuditor(
        restartedJournal,
        restartedSpool,
      ),
      recovery,
    });

    await expect(publication.publish()).resolves.toMatchObject({
      state: "completed",
      publication: "recovered",
      work: { state: "completed", completion: { acknowledgedSequence: 2 } },
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
  });

  it("completes acknowledged durable evidence locally and replays without recovery", async () => {
    const path = root();
    const journal = await openJournal(path);
    await journal.admit(delivery);
    await journal.commitClaim(delivery.deliveryId, execution);
    await journal.commitExecutionStart(delivery.deliveryId, execution);
    const baseline = await journal.inspect(delivery.deliveryId);
    if (!baseline) throw new Error("missing test work");
    const spool = await openSpool(path);
    const events = await spool.append(execution, terminalDrafts);
    for (const event of events) {
      await spool.acknowledge(execution, acknowledgement(event));
    }

    const restartedJournal = await openJournal(path);
    const restartedSpool = await openSpool(path);
    const recovery = new TerminalEvidenceRecoveryCoordinator(
      restartedSpool,
      { sendNext: vi.fn() },
      new WorkCompletionCoordinator(restartedJournal, restartedSpool),
    );
    const recover = vi.spyOn(recovery, "recover");
    const publication = new RecoveryOnlyTerminalPublication({
      work: baseline,
      deliveryId: delivery.deliveryId,
      execution,
      auditor: new TerminalPublicationDispositionAuditor(
        restartedJournal,
        restartedSpool,
      ),
      recovery,
    });

    await expect(publication.publish()).resolves.toMatchObject({
      state: "completed",
      work: { state: "completed" },
    });
    expect(recover).toHaveBeenCalledOnce();
    await expect(publication.publish()).resolves.toMatchObject({
      state: "completed",
      publication: "recovered",
    });
    expect(recover).toHaveBeenCalledOnce();
  });

  it("leaves an absent durable spool absent without invoking recovery", async () => {
    const path = root();
    const journal = await openJournal(path);
    await journal.admit(delivery);
    await journal.commitClaim(delivery.deliveryId, execution);
    const baseline = await journal.inspect(delivery.deliveryId);
    if (!baseline) throw new Error("missing test work");
    const spool = await openSpool(path);
    const recover = vi.fn();
    const publication = new RecoveryOnlyTerminalPublication({
      work: baseline,
      deliveryId: delivery.deliveryId,
      execution,
      auditor: new TerminalPublicationDispositionAuditor(journal, spool),
      recovery: { recover },
    });

    await expect(publication.publish()).rejects.toMatchObject({
      code: "recovery_evidence_missing",
    });
    expect(recover).not.toHaveBeenCalled();
    await expect(spool.inspectExisting(execution)).resolves.toBeNull();
  });
});
