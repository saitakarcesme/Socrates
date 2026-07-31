import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runnerExecutionV1Schema,
  type RunnerTaskDeliveryV1,
} from "@socrates/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runnerEventDraft } from "../lifecycle/draft";
import { LocalEventSpool } from "../spool/store";
import type { RunnerControlPlaneClient } from "../transport/client";
import { WorkCompletionCoordinator } from "./completion-coordinator";
import { WorkAdmissionCoordinator } from "./coordinator";
import { LocalWorkJournal } from "./store";
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
const roots: string[] = [];

function root(): string {
  const value = join(
    tmpdir(),
    `socrates-completion-${crypto.randomUUID().replaceAll("-", "")}`,
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
      attemptId: () => attemptId,
      now: () => new Date("2026-07-31T12:00:00.000Z"),
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
      now: () => new Date("2026-07-31T12:00:00.000Z"),
    },
    directorySync: { sync: async () => undefined },
  });
}

async function claimedJournal(path: string): Promise<LocalWorkJournal> {
  const journal = await openJournal(path);
  await journal.admit(delivery);
  await journal.commitClaim(delivery.deliveryId, execution);
  return journal;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("WorkCompletionCoordinator", () => {
  it("completes only after exact terminal acknowledgement", async () => {
    const path = root();
    const journal = await claimedJournal(path);
    const spool = await openSpool(path);
    const coordinator = new WorkCompletionCoordinator(journal, spool);

    await expect(coordinator.complete(delivery.deliveryId)).resolves.toEqual({
      state: "not_ready",
      reason: "terminal_acknowledgement_missing",
    });
    await journal.commitExecutionStart(delivery.deliveryId, execution);
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
    await expect(coordinator.complete(delivery.deliveryId)).resolves.toEqual({
      state: "not_ready",
      reason: "terminal_acknowledgement_missing",
    });
    for (const event of events) {
      await spool.acknowledge(execution, {
        version: "1",
        eventId: event.eventId,
        attemptId: event.attemptId,
        acknowledgedSequence: event.sequence,
        expectedSequence: event.sequence + 1,
        receivedAt: "2026-07-31T12:00:01.000Z",
      });
    }

    await expect(
      coordinator.complete(delivery.deliveryId),
    ).resolves.toMatchObject({
      state: "completed",
      replay: false,
      work: {
        state: "completed",
        executionStartedAt: "2026-07-31T12:00:00.000Z",
        completion: { acknowledgedSequence: 2 },
      },
    });
  });

  it("replays completion locally and lets later admission acquire", async () => {
    const path = root();
    const journal = await claimedJournal(path);
    await journal.commitCompletion(delivery.deliveryId, execution, {
      attemptKey: "a".repeat(64),
      acknowledgedSequence: 2,
    });
    const inspect = vi.fn();
    await expect(
      new WorkCompletionCoordinator(journal, { inspect }).complete(
        delivery.deliveryId,
      ),
    ).resolves.toMatchObject({ state: "completed", replay: true });
    expect(inspect).not.toHaveBeenCalled();

    const acquireTaskDelivery = vi.fn().mockResolvedValue(null);
    const admission = new WorkAdmissionCoordinator({
      journal,
      client: { acquireTaskDelivery } as RunnerControlPlaneClient,
      leaseDurationMs: 60_000,
      terminalRecovery: {
        recover: async () => Object.freeze({ state: "none" as const }),
      },
    });
    await expect(admission.prepareNext()).resolves.toEqual({ state: "idle" });
    expect(acquireTaskDelivery).toHaveBeenCalledOnce();
  });

  it("fails closed on mismatched spool identity", async () => {
    const path = root();
    const journal = await claimedJournal(path);
    const coordinator = new WorkCompletionCoordinator(journal, {
      inspect: async () => ({
        attemptKey: "f".repeat(64),
        acknowledgedSequence: 1,
        lastSequence: 1,
        pendingEvents: 0,
        terminal: true,
      }),
    });
    await expect(
      coordinator.complete(delivery.deliveryId),
    ).rejects.toMatchObject({
      code: "identity_conflict",
    });
    await expect(journal.inspect(delivery.deliveryId)).resolves.toMatchObject({
      state: "claimed",
    });
  });
});
