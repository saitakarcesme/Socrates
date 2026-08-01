import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runnerExecutionV1Schema,
  type RunnerExecutionV1,
} from "@socrates/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runnerEventDraft, type RunnerEventDraft } from "../lifecycle/draft";
import { attemptKeyFor } from "../spool/codec";
import type { SpoolState } from "../spool/contracts";
import { LocalEventSpool, type SpoolIdentitySource } from "../spool/store";
import { SequentialSpoolSender } from "../transport/sender";
import { WorkCompletionCoordinator } from "./completion-coordinator";
import { LocalWorkJournal } from "./store";
import {
  TerminalEvidencePublicationCoordinator,
  TerminalEvidencePublicationDeferredError,
} from "./terminal-evidence-publication";
import { TerminalEvidenceRecoveryCoordinator } from "./terminal-evidence-recovery";
import type { WorkJournalState } from "./contracts";
import taskFixture from "../../../../packages/contracts/fixtures/runner/task-v2.json";

const deliveryId = "40000000-0000-4000-8000-000000000004";
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
const attemptKey = attemptKeyFor(execution);
const terminalDrafts = Object.freeze([
  runnerEventDraft({
    type: "action.started",
    payload: { commandIndex: 0 },
  }),
  runnerEventDraft({
    type: "task.failed",
    payload: {
      classification: "infrastructure",
      message: "Fixed publication failure.",
    },
  }),
]);
const roots: string[] = [];

function work(state: WorkJournalState["state"] = "claimed"): WorkJournalState {
  return Object.freeze({
    deliveryId,
    taskId: execution.lease.taskId,
    attemptId: execution.lease.attemptId,
    state,
    admittedAt: "2026-08-01T00:00:00.000Z",
    ...(state !== "pending_claim"
      ? { claimedAt: "2026-08-01T00:00:01.000Z" }
      : {}),
    ...(state === "execution_started"
      ? { executionStartedAt: "2026-08-01T00:00:02.000Z" }
      : {}),
    ...(state === "completed"
      ? {
          completedAt: "2026-08-01T00:00:03.000Z",
          completion: {
            attemptKey,
            acknowledgedSequence: 2,
          },
        }
      : {}),
  });
}

function spool(overrides: Partial<SpoolState> = {}): SpoolState {
  return {
    attemptKey,
    acknowledgedSequence: 0,
    lastSequence: 2,
    pendingEvents: 2,
    terminal: true,
    ...overrides,
  };
}

function completedRecovery() {
  return Object.freeze({
    state: "completed" as const,
    work: work("completed"),
  });
}

function fixture(options: {
  states?: readonly (WorkJournalState | null)[];
  executions?: readonly (RunnerExecutionV1 | null)[];
  recoveries?: readonly (
    { state: "none" } | ReturnType<typeof completedRecovery> | Error
  )[];
  spoolStates?: readonly (SpoolState | null | Error)[];
  append?: () => Promise<unknown>;
}) {
  const states = [...(options.states ?? [work(), work()])];
  const executions = [...(options.executions ?? [execution, execution])];
  const recoveries = [...(options.recoveries ?? [])];
  const spoolStates = [...(options.spoolStates ?? [])];
  const inspect = vi.fn(async () => states.shift() ?? null);
  const claimedExecution = vi.fn(async () => executions.shift() ?? null);
  const append = vi.fn(options.append ?? (async () => []));
  const inspectExisting = vi.fn(async () => {
    const result = spoolStates.shift() ?? null;
    if (result instanceof Error) throw result;
    return result;
  });
  const recover = vi.fn(async () => {
    const result = recoveries.shift();
    if (!result) throw new Error("Unexpected recovery.");
    if (result instanceof Error) throw result;
    return result;
  });
  return {
    append,
    claimedExecution,
    inspect,
    inspectExisting,
    recover,
    value: new TerminalEvidencePublicationCoordinator(
      { inspect, claimedExecution },
      { append, inspectExisting },
      { recover },
    ),
  };
}

function root(): string {
  const value = join(
    tmpdir(),
    `socrates-terminal-publication-${crypto.randomUUID().replaceAll("-", "")}`,
  );
  roots.push(value);
  return value;
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
  identitySource?: SpoolIdentitySource,
): Promise<LocalEventSpool> {
  let event = 1;
  return LocalEventSpool.open({
    rootPath: join(path, "spool"),
    limits: {
      maximumSegmentBytes: 1_000_000,
      maximumEventsPerSegment: 100,
      maximumAttempts: 10,
      maximumSpoolBytes: 10_000_000,
    },
    identitySource: identitySource ?? {
      eventId: () =>
        `30000000-0000-4000-8000-${(event++).toString(16).padStart(12, "0")}`,
      now: () => new Date("2026-08-01T00:00:00.000Z"),
    },
    directorySync: { sync: async () => undefined },
  });
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("TerminalEvidencePublicationCoordinator", () => {
  it.each([
    {
      label: "invalid delivery",
      input: { deliveryId: "invalid", execution, drafts: terminalDrafts },
    },
    { label: "empty batch", input: { deliveryId, execution, drafts: [] } },
    {
      label: "non-terminal batch",
      input: {
        deliveryId,
        execution,
        drafts: [terminalDrafts[0]!],
      },
    },
    {
      label: "invalid payload",
      input: {
        deliveryId,
        execution,
        drafts: [
          {
            type: "task.cancelled",
            payload: { forced: false, durationMs: -1 },
          } as RunnerEventDraft,
        ],
      },
    },
  ])(
    "rejects $label before journal, spool, or recovery effects",
    async ({ input }) => {
      const value = fixture({});

      await expect(value.value.publish(input)).rejects.toMatchObject({
        code: "invalid_input",
      });
      expect(value.inspect).not.toHaveBeenCalled();
      expect(value.append).not.toHaveBeenCalled();
      expect(value.inspectExisting).not.toHaveBeenCalled();
      expect(value.recover).not.toHaveBeenCalled();
    },
  );

  it.each(["pending_claim", "rejected", "retired"] as const)(
    "rejects %s work before recovery or append",
    async (state) => {
      const value = fixture({ states: [work(state)] });

      await expect(
        value.value.publish({ deliveryId, execution, drafts: terminalDrafts }),
      ).rejects.toMatchObject({ code: "work_not_publishable" });
      expect(value.recover).not.toHaveBeenCalled();
      expect(value.append).not.toHaveBeenCalled();
      expect(value.inspectExisting).not.toHaveBeenCalled();
    },
  );

  it("rejects a missing delivery before recovery or append", async () => {
    const value = fixture({ states: [null] });

    await expect(
      value.value.publish({ deliveryId, execution, drafts: terminalDrafts }),
    ).rejects.toMatchObject({ code: "work_not_publishable" });
    expect(value.recover).not.toHaveBeenCalled();
    expect(value.append).not.toHaveBeenCalled();
    expect(value.inspectExisting).not.toHaveBeenCalled();
  });

  it("rejects a different durable execution before recovery", async () => {
    const drifted = runnerExecutionV1Schema.parse({
      ...execution,
      lease: { ...execution.lease, fence: execution.lease.fence + 1 },
    });
    const value = fixture({ executions: [drifted] });

    await expect(
      value.value.publish({ deliveryId, execution, drafts: terminalDrafts }),
    ).rejects.toMatchObject({ code: "identity_conflict" });
    expect(value.recover).not.toHaveBeenCalled();
    expect(value.append).not.toHaveBeenCalled();
    expect(value.inspectExisting).not.toHaveBeenCalled();
  });

  it("recovers existing exact evidence without appending", async () => {
    const value = fixture({ recoveries: [completedRecovery()] });

    const result = await value.value.publish({
      deliveryId,
      execution,
      drafts: terminalDrafts,
    });

    expect(result).toEqual({
      state: "completed",
      publication: "recovered",
      work: work("completed"),
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(value.append).not.toHaveBeenCalled();
  });

  it("rejects completed work without recoverable evidence", async () => {
    const value = fixture({
      states: [work("completed")],
      recoveries: [{ state: "none" }],
    });

    await expect(
      value.value.publish({ deliveryId, execution, drafts: terminalDrafts }),
    ).rejects.toMatchObject({ code: "completed_evidence_missing" });
    expect(value.append).not.toHaveBeenCalled();
  });

  it("revalidates active ownership immediately before append", async () => {
    const value = fixture({
      states: [work(), work("completed")],
      recoveries: [{ state: "none" }],
    });

    await expect(
      value.value.publish({ deliveryId, execution, drafts: terminalDrafts }),
    ).rejects.toMatchObject({ code: "work_not_publishable" });
    expect(value.append).not.toHaveBeenCalled();
  });

  it("defers a recovery-before-append ambiguity with an absent disposition", async () => {
    const ambiguity = new Error("event acknowledgement ambiguous");
    const value = fixture({ recoveries: [ambiguity] });

    const failure = await value.value
      .publish({ deliveryId, execution, drafts: terminalDrafts })
      .catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(TerminalEvidencePublicationDeferredError);
    expect(failure).toMatchObject({
      code: "publication_deferred",
      boundary: "recovery_before_append",
      cause: ambiguity,
      disposition: { state: "absent", work: work() },
    });
    expect(Object.isFrozen(failure)).toBe(true);
    expect(Object.isFrozen(failure.disposition)).toBe(true);
    expect(failure.message).not.toContain(ambiguity.message);
    expect(value.append).not.toHaveBeenCalled();
  });

  it("appends once and requires completion through recovery", async () => {
    const order: string[] = [];
    const value = fixture({
      recoveries: [{ state: "none" }, completedRecovery()],
      append: async () => {
        order.push("append");
        return [];
      },
    });
    value.recover.mockImplementation(async () => {
      order.push("recover");
      return order.length === 1 ? { state: "none" } : completedRecovery();
    });

    await expect(
      value.value.publish({ deliveryId, execution, drafts: terminalDrafts }),
    ).resolves.toMatchObject({
      state: "completed",
      publication: "appended",
    });
    expect(order).toEqual(["recover", "append", "recover"]);
    expect(value.append).toHaveBeenCalledOnce();
    expect(value.append).toHaveBeenCalledWith(execution, terminalDrafts);
  });

  it("rejects recovery none after append as an invariant failure", async () => {
    const value = fixture({
      recoveries: [{ state: "none" }, { state: "none" }],
    });

    await expect(
      value.value.publish({ deliveryId, execution, drafts: terminalDrafts }),
    ).rejects.toMatchObject({ code: "publication_not_recoverable" });
    expect(value.append).toHaveBeenCalledOnce();
  });

  it("defers append ambiguity as pending and recovers it on the next call", async () => {
    const ambiguity = new Error("append completion ambiguous");
    const value = fixture({
      states: [work(), work(), work(), work("completed")],
      executions: [execution, execution, execution, execution],
      recoveries: [{ state: "none" }, completedRecovery()],
      spoolStates: [spool()],
      append: async () => Promise.reject(ambiguity),
    });

    await expect(
      value.value.publish({ deliveryId, execution, drafts: terminalDrafts }),
    ).rejects.toMatchObject({
      code: "publication_deferred",
      boundary: "append",
      cause: ambiguity,
      disposition: {
        state: "pending",
        acknowledgedSequence: 0,
        lastSequence: 2,
        pendingEvents: 2,
      },
    });
    await expect(
      value.value.publish({ deliveryId, execution, drafts: terminalDrafts }),
    ).resolves.toMatchObject({ publication: "recovered" });
    expect(value.append).toHaveBeenCalledOnce();
  });

  it("defers recovery-after-append ambiguity with acknowledged evidence", async () => {
    const ambiguity = new Error("completion response lost");
    const value = fixture({
      states: [work(), work(), work()],
      executions: [execution, execution, execution],
      recoveries: [{ state: "none" }, ambiguity],
      spoolStates: [spool({ acknowledgedSequence: 2, pendingEvents: 0 })],
    });

    await expect(
      value.value.publish({ deliveryId, execution, drafts: terminalDrafts }),
    ).rejects.toMatchObject({
      code: "publication_deferred",
      boundary: "recovery_after_append",
      cause: ambiguity,
      disposition: {
        state: "acknowledged",
        acknowledgedSequence: 2,
        lastSequence: 2,
        pendingEvents: 0,
      },
    });
    expect(value.append).toHaveBeenCalledOnce();
  });

  it("recovers a lost response when the disposition proves completion", async () => {
    const ambiguity = new Error("completion response lost");
    const value = fixture({
      states: [work(), work(), work("completed")],
      executions: [execution, execution, execution],
      recoveries: [{ state: "none" }, ambiguity],
      spoolStates: [spool({ acknowledgedSequence: 2, pendingEvents: 0 })],
    });

    await expect(
      value.value.publish({ deliveryId, execution, drafts: terminalDrafts }),
    ).resolves.toEqual({
      state: "completed",
      publication: "recovered",
      work: work("completed"),
    });
    expect(value.append).toHaveBeenCalledOnce();
  });

  it("reports publication uncertainty when the disposition audit fails", async () => {
    const ambiguity = new Error("event acknowledgement ambiguous");
    const value = fixture({
      states: [work(), null],
      executions: [execution],
      recoveries: [ambiguity],
    });

    const failure = await value.value
      .publish({ deliveryId, execution, drafts: terminalDrafts })
      .catch((cause: unknown) => cause);

    expect(failure).toMatchObject({
      code: "publication_state_uncertain",
      boundary: "recovery_before_append",
      message: "Terminal evidence publication state is uncertain.",
    });
    expect(Object.isFrozen(failure)).toBe(true);
    expect(failure.cause).toBeInstanceOf(AggregateError);
    expect((failure.cause as AggregateError).errors[0]).toBe(ambiguity);
    expect((failure.cause as AggregateError).errors[1]).toMatchObject({
      code: "state_uncertain",
    });
    expect(failure.message).not.toContain(ambiguity.message);
    expect(value.append).not.toHaveBeenCalled();
  });

  it.each([
    {
      boundary: "append",
      states: [work(), work(), null],
      executions: [execution, execution],
      recoveries: [{ state: "none" as const }],
      append: async () => Promise.reject(new Error("append failed")),
    },
    {
      boundary: "recovery_after_append",
      states: [work(), work(), null],
      executions: [execution, execution],
      recoveries: [{ state: "none" as const }, new Error("recovery failed")],
      append: async () => [],
    },
  ])(
    "retains the $boundary boundary when its disposition audit fails",
    async ({ append, boundary, executions, recoveries, states }) => {
      const value = fixture({
        append,
        executions,
        recoveries,
        states,
      });

      await expect(
        value.value.publish({ deliveryId, execution, drafts: terminalDrafts }),
      ).rejects.toMatchObject({
        code: "publication_state_uncertain",
        boundary,
      });
    },
  );

  it("serializes concurrent duplicates into one append", async () => {
    const value = fixture({
      states: [work(), work(), work("completed")],
      executions: [execution, execution, execution],
      recoveries: [{ state: "none" }, completedRecovery(), completedRecovery()],
    });

    const [first, second] = await Promise.all([
      value.value.publish({ deliveryId, execution, drafts: terminalDrafts }),
      value.value.publish({ deliveryId, execution, drafts: terminalDrafts }),
    ]);

    expect([first.publication, second.publication]).toEqual([
      "appended",
      "recovered",
    ]);
    expect(value.append).toHaveBeenCalledOnce();
  });

  it("audits real committed spool evidence without a second durable append", async () => {
    const path = root();
    const journal = await openJournal(path);
    await journal.admit({
      version: "1",
      deliveryId,
      taskId: execution.lease.taskId,
    });
    await journal.commitClaim(deliveryId, execution);
    const spool = await openSpool(path);
    await spool.append(execution, terminalDrafts);
    const append = vi.spyOn(spool, "append");
    append.mockClear();
    const ambiguity = new Error("recovery unavailable");
    const value = new TerminalEvidencePublicationCoordinator(journal, spool, {
      recover: async () => Promise.reject(ambiguity),
    });

    await expect(
      value.publish({ deliveryId, execution, drafts: terminalDrafts }),
    ).rejects.toMatchObject({
      code: "publication_deferred",
      boundary: "recovery_before_append",
      cause: ambiguity,
      disposition: {
        state: "pending",
        acknowledgedSequence: 0,
        lastSequence: 2,
        pendingEvents: 2,
      },
    });
    expect(append).not.toHaveBeenCalled();
    await expect(spool.inspectExisting(execution)).resolves.toMatchObject({
      acknowledgedSequence: 0,
      lastSequence: 2,
      pendingEvents: 2,
      terminal: true,
    });
  });

  it("publishes, completes, and replays through real durable stores", async () => {
    const path = root();
    const journal = await openJournal(path);
    await journal.admit({
      version: "1",
      deliveryId,
      taskId: execution.lease.taskId,
    });
    await journal.commitClaim(deliveryId, execution);
    const spool = await openSpool(path);
    const submitEvent = vi.fn(
      async (event: {
        eventId: string;
        attemptId: string;
        sequence: number;
      }) => ({
        version: "1" as const,
        replay: false,
        acknowledgement: {
          version: "1" as const,
          eventId: event.eventId,
          attemptId: event.attemptId,
          acknowledgedSequence: event.sequence,
          expectedSequence: event.sequence + 1,
          receivedAt: "2026-08-01T00:00:02.000Z",
        },
      }),
    );
    const recovery = new TerminalEvidenceRecoveryCoordinator(
      spool,
      new SequentialSpoolSender(spool, { submitEvent }),
      new WorkCompletionCoordinator(journal, spool),
    );
    const publisher = new TerminalEvidencePublicationCoordinator(
      journal,
      spool,
      recovery,
    );

    await expect(
      publisher.publish({ deliveryId, execution, drafts: terminalDrafts }),
    ).resolves.toMatchObject({
      state: "completed",
      publication: "appended",
      work: { state: "completed" },
    });
    expect(submitEvent).toHaveBeenCalledTimes(terminalDrafts.length);

    const restartedJournal = await openJournal(path);
    const restartedSpool = await openSpool(path, {
      eventId: () => {
        throw new Error("Completed replay must not allocate an event ID.");
      },
      now: () => {
        throw new Error("Completed replay must not read the spool clock.");
      },
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
    const restartedPublisher = new TerminalEvidencePublicationCoordinator(
      restartedJournal,
      restartedSpool,
      restartedRecovery,
    );

    await expect(
      restartedPublisher.publish({
        deliveryId,
        execution,
        drafts: terminalDrafts,
      }),
    ).resolves.toMatchObject({
      state: "completed",
      publication: "recovered",
      work: { state: "completed" },
    });
    expect(replaySubmit).not.toHaveBeenCalled();
  });
});
