import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runnerExecutionV1Schema } from "@socrates/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runnerEventDraft } from "../lifecycle/draft";
import { LocalEventSpool } from "../spool/store";
import { SequentialSpoolSender } from "../transport/sender";
import { WorkCompletionCoordinator } from "./completion-coordinator";
import { LocalWorkJournal } from "./store";
import {
  TerminalEvidenceRecoveryCoordinator,
  TerminalEvidenceRecoveryError,
} from "./terminal-evidence-recovery";
import { attemptKeyFor } from "../spool/codec";
import type { SpoolState } from "../spool/contracts";
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
    fence: 3,
    leasedUntil: "2026-07-31T22:00:00.000Z",
  },
  task: taskFixture,
});

const attemptKey = attemptKeyFor(execution);
const roots: string[] = [];

function root(): string {
  const value = join(
    tmpdir(),
    `socrates-terminal-recovery-${crypto.randomUUID().replaceAll("-", "")}`,
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
      now: () => new Date("2026-07-31T21:00:00.000Z"),
    },
    directorySync: { sync: async () => undefined },
  });
}

async function openSpool(path: string): Promise<LocalEventSpool> {
  let event = 1;
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
        `30000000-0000-4000-8000-${(event++).toString(16).padStart(12, "0")}`,
      now: () => new Date("2026-07-31T21:00:00.000Z"),
    },
    directorySync: { sync: async () => undefined },
  });
}

function spoolState(overrides: Partial<SpoolState> = {}): SpoolState {
  return {
    attemptKey,
    acknowledgedSequence: 0,
    lastSequence: 3,
    pendingEvents: 3,
    terminal: true,
    ...overrides,
  };
}

function completedWork(): WorkJournalState {
  return Object.freeze({
    deliveryId,
    taskId: execution.lease.taskId,
    attemptId: execution.lease.attemptId,
    state: "completed",
    admittedAt: "2026-07-31T21:00:00.000Z",
    claimedAt: "2026-07-31T21:00:01.000Z",
    executionStartedAt: "2026-07-31T21:00:02.000Z",
    completedAt: "2026-07-31T21:00:03.000Z",
    completion: { attemptKey, acknowledgedSequence: 3 },
  });
}

function fixture(options: {
  inspections: readonly (SpoolState | null)[];
  sends?: readonly (
    | { state: "idle" }
    | {
        state: "acknowledged";
        eventId: string;
        sequence: number;
        replay: boolean;
      }
    | Error
  )[];
  completion?:
    | { state: "not_ready"; reason: "terminal_acknowledgement_missing" }
    | { state: "completed"; work: WorkJournalState; replay: boolean }
    | Error;
}) {
  const inspections = [...options.inspections];
  const sends = [...(options.sends ?? [])];
  const inspectExisting = vi.fn(async () => {
    if (inspections.length === 0) throw new Error("Unexpected inspection.");
    return inspections.shift()!;
  });
  const sendNext = vi.fn(async () => {
    const result = sends.shift();
    if (!result) throw new Error("Unexpected send.");
    if (result instanceof Error) throw result;
    return result;
  });
  const completionResult = options.completion ?? {
    state: "completed" as const,
    work: completedWork(),
    replay: false,
  };
  const complete = vi.fn(async () => {
    if (completionResult instanceof Error) throw completionResult;
    return completionResult;
  });
  return {
    complete,
    inspectExisting,
    sendNext,
    value: new TerminalEvidenceRecoveryCoordinator(
      { inspectExisting },
      { sendNext },
      { complete },
    ),
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("TerminalEvidenceRecoveryCoordinator", () => {
  it("resumes a partially acknowledged terminal batch after filesystem restart", async () => {
    const path = root();
    const journal = await openJournal(path);
    await journal.admit({
      version: "1",
      deliveryId,
      taskId: execution.lease.taskId,
    });
    await journal.commitClaim(deliveryId, execution);
    await journal.commitExecutionStart(deliveryId, execution);
    const spool = await openSpool(path);
    const events = await spool.append(execution, [
      runnerEventDraft({
        type: "workspace.prepared",
        payload: {
          sourceDigest: execution.task.source.digest,
          imageDigest: execution.task.environment.imageDigest,
        },
      }),
      runnerEventDraft({
        type: "task.failed",
        payload: {
          classification: "infrastructure",
          message: "Fixed terminal evidence.",
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
      receivedAt: "2026-07-31T21:00:01.000Z",
    });

    const restartedJournal = await openJournal(path);
    const restartedSpool = await openSpool(path);
    const submitEvent = vi.fn(async (event: (typeof events)[number]) => ({
      version: "1" as const,
      replay: true,
      acknowledgement: {
        version: "1" as const,
        eventId: event.eventId,
        attemptId: event.attemptId,
        acknowledgedSequence: event.sequence,
        expectedSequence: event.sequence + 1,
        receivedAt: "2026-07-31T21:00:02.000Z",
      },
    }));
    const recovery = new TerminalEvidenceRecoveryCoordinator(
      restartedSpool,
      new SequentialSpoolSender(restartedSpool, { submitEvent }),
      new WorkCompletionCoordinator(restartedJournal, restartedSpool),
    );

    await expect(
      recovery.recover(deliveryId, execution),
    ).resolves.toMatchObject({
      state: "completed",
      work: {
        state: "completed",
        completion: { acknowledgedSequence: 2 },
      },
    });
    expect(submitEvent).toHaveBeenCalledOnce();
    expect(submitEvent.mock.calls[0]?.[0]).toEqual(events[1]);
    await expect(
      restartedSpool.inspectExisting(execution),
    ).resolves.toMatchObject({
      acknowledgedSequence: 2,
      pendingEvents: 0,
      terminal: true,
    });
  });

  it.each([
    ["absent", null],
    [
      "empty",
      spoolState({
        acknowledgedSequence: 0,
        lastSequence: 0,
        pendingEvents: 0,
        terminal: false,
      }),
    ],
  ] as const)("returns none for %s exact spool state", async (_name, state) => {
    const value = fixture({ inspections: [state] });

    const result = await value.value.recover(deliveryId, execution);
    expect(result).toEqual({ state: "none" });
    expect(Object.isFrozen(result)).toBe(true);
    expect(value.sendNext).not.toHaveBeenCalled();
    expect(value.complete).not.toHaveBeenCalled();
  });

  it("drains exactly the initial pending range and completes work", async () => {
    const value = fixture({
      inspections: [
        spoolState({ acknowledgedSequence: 1, pendingEvents: 2 }),
        spoolState({ acknowledgedSequence: 3, pendingEvents: 0 }),
      ],
      sends: [
        {
          state: "acknowledged",
          eventId: "30000000-0000-4000-8000-000000000002",
          sequence: 2,
          replay: true,
        },
        {
          state: "acknowledged",
          eventId: "30000000-0000-4000-8000-000000000003",
          sequence: 3,
          replay: false,
        },
      ],
    });

    const result = await value.value.recover(deliveryId, execution);
    expect(result).toMatchObject({ state: "completed", work: completedWork() });
    expect(Object.isFrozen(result)).toBe(true);
    expect(value.sendNext).toHaveBeenCalledTimes(2);
    expect(value.sendNext).toHaveBeenNthCalledWith(1, execution);
    expect(value.complete).toHaveBeenCalledWith(deliveryId);
  });

  it("completes an already acknowledged terminal tombstone without sending", async () => {
    const terminal = spoolState({
      acknowledgedSequence: 3,
      pendingEvents: 0,
    });
    const value = fixture({ inspections: [terminal, terminal] });

    await expect(
      value.value.recover(deliveryId, execution),
    ).resolves.toMatchObject({ state: "completed" });
    expect(value.sendNext).not.toHaveBeenCalled();
    expect(value.complete).toHaveBeenCalledOnce();
  });

  it.each([
    spoolState({ attemptKey: "f".repeat(64) }),
    spoolState({ terminal: false }),
    spoolState({ lastSequence: 0, pendingEvents: 0 }),
    spoolState({ acknowledgedSequence: 4, pendingEvents: 0 }),
    spoolState({ acknowledgedSequence: 1, pendingEvents: 1 }),
    spoolState({ pendingEvents: 1.5 }),
  ])("rejects invalid existing terminal state %#", async (state) => {
    const value = fixture({ inspections: [state] });

    await expect(
      value.value.recover(deliveryId, execution),
    ).rejects.toMatchObject<Partial<TerminalEvidenceRecoveryError>>({
      code: "invalid_spool_state",
    });
    expect(value.sendNext).not.toHaveBeenCalled();
    expect(value.complete).not.toHaveBeenCalled();
  });

  it("fails closed when the sender becomes idle before the frozen bound", async () => {
    const value = fixture({
      inspections: [spoolState()],
      sends: [{ state: "idle" }],
    });

    await expect(
      value.value.recover(deliveryId, execution),
    ).rejects.toMatchObject({ code: "premature_idle" });
    expect(value.complete).not.toHaveBeenCalled();
  });

  it("fails closed when acknowledgement sequence drifts", async () => {
    const value = fixture({
      inspections: [spoolState()],
      sends: [
        {
          state: "acknowledged",
          eventId: "30000000-0000-4000-8000-000000000002",
          sequence: 2,
          replay: false,
        },
      ],
    });

    await expect(
      value.value.recover(deliveryId, execution),
    ).rejects.toMatchObject({ code: "state_drift" });
    expect(value.complete).not.toHaveBeenCalled();
  });

  it("rejects final spool drift before work completion", async () => {
    const value = fixture({
      inspections: [
        spoolState({ acknowledgedSequence: 2, pendingEvents: 1 }),
        spoolState({
          acknowledgedSequence: 3,
          lastSequence: 4,
          pendingEvents: 1,
        }),
      ],
      sends: [
        {
          state: "acknowledged",
          eventId: "30000000-0000-4000-8000-000000000003",
          sequence: 3,
          replay: false,
        },
      ],
    });

    await expect(
      value.value.recover(deliveryId, execution),
    ).rejects.toMatchObject({ code: "state_drift" });
    expect(value.complete).not.toHaveBeenCalled();
  });

  it("rejects completion that remains not ready after the drain", async () => {
    const terminal = spoolState({
      acknowledgedSequence: 3,
      pendingEvents: 0,
    });
    const value = fixture({
      inspections: [terminal, terminal],
      completion: {
        state: "not_ready",
        reason: "terminal_acknowledgement_missing",
      },
    });

    await expect(
      value.value.recover(deliveryId, execution),
    ).rejects.toMatchObject({ code: "completion_not_ready" });
  });

  it("propagates sender ambiguity without inspecting or completing again", async () => {
    const failure = new Error("transport ambiguous");
    const value = fixture({
      inspections: [spoolState()],
      sends: [failure],
    });

    await expect(value.value.recover(deliveryId, execution)).rejects.toBe(
      failure,
    );
    expect(value.inspectExisting).toHaveBeenCalledOnce();
    expect(value.complete).not.toHaveBeenCalled();
  });
});
