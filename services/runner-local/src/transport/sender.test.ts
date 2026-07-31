import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runnerExecutionV1Schema,
  type RunnerEventSubmitResponseV1,
} from "@socrates/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import taskFixture from "../../../../packages/contracts/fixtures/runner/task-v2.json";
import { runnerEventDraft } from "../lifecycle/draft";
import {
  LocalEventSpool,
  type SpoolIdentitySource,
  type SpoolLimits,
} from "../spool/index";
import { RunnerDeliveryError, SequentialSpoolSender } from "./sender";

const execution = runnerExecutionV1Schema.parse({
  version: "1",
  lease: {
    version: "1",
    runnerId: "10000000-0000-4000-8000-000000000001",
    taskId: taskFixture.taskId,
    attemptId: "20000000-0000-4000-8000-000000000002",
    fence: 1,
    leasedUntil: "2026-07-31T18:00:00.000Z",
  },
  task: taskFixture,
});
const limits: SpoolLimits = {
  maximumSegmentBytes: 1_000_000,
  maximumEventsPerSegment: 10,
  maximumAttempts: 10,
  maximumSpoolBytes: 10_000_000,
};
const roots: string[] = [];

function root(): string {
  const value = join(tmpdir(), `socrates-sender-${crypto.randomUUID()}`);
  roots.push(value);
  return value;
}

function identities(): SpoolIdentitySource {
  let next = 1;
  return {
    eventId: () =>
      `30000000-0000-4000-8000-${(next++).toString(16).padStart(12, "0")}`,
    now: () => new Date("2026-07-31T12:00:00.000Z"),
  };
}

async function spool(rootPath: string) {
  return LocalEventSpool.open({
    rootPath,
    limits,
    identitySource: identities(),
    directorySync: { sync: async () => undefined },
  });
}

function response(event: {
  eventId: string;
  attemptId: string;
  sequence: number;
}): RunnerEventSubmitResponseV1 {
  return {
    version: "1",
    replay: false,
    acknowledgement: {
      version: "1",
      eventId: event.eventId,
      attemptId: event.attemptId,
      acknowledgedSequence: event.sequence,
      expectedSequence: event.sequence + 1,
      receivedAt: "2026-07-31T12:00:01.000Z",
    },
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("sequential spool sender", () => {
  it("preserves the exact pending event after an ambiguous transport failure", async () => {
    const rootPath = root();
    const store = await spool(rootPath);
    const committed = await store.append(execution, [
      runnerEventDraft({
        type: "task.failed",
        payload: {
          classification: "infrastructure",
          message: "Controlled failure.",
        },
      }),
    ]);
    const sender = new SequentialSpoolSender(store, {
      submitEvent: async () => {
        throw new Error("ambiguous network failure");
      },
    });

    await expect(sender.sendNext(execution)).rejects.toThrow("ambiguous");
    const restarted = await spool(rootPath);
    await expect(restarted.pending(execution)).resolves.toEqual(committed);
  });

  it("advances only the exact acknowledgement and resumes at the next event", async () => {
    const rootPath = root();
    const store = await spool(rootPath);
    const committed = await store.append(execution, [
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
          message: "Controlled failure.",
        },
      }),
    ]);
    const submitEvent = vi.fn(async (value: (typeof committed)[number]) =>
      response(value),
    );
    const sender = new SequentialSpoolSender(store, { submitEvent });

    await expect(sender.sendNext(execution)).resolves.toMatchObject({
      state: "acknowledged",
      eventId: committed[0]?.eventId,
      sequence: 1,
    });
    await expect((await store.pending(execution))[0]).toEqual(committed[1]);

    await expect(sender.sendNext(execution)).resolves.toMatchObject({
      state: "acknowledged",
      eventId: committed[1]?.eventId,
      sequence: 2,
    });
    await expect(store.pending(execution)).resolves.toEqual([]);
    expect(submitEvent).toHaveBeenCalledTimes(2);
  });

  it("fails before durable advancement when acknowledgement identity differs", async () => {
    const rootPath = root();
    const store = await spool(rootPath);
    const [committed] = await store.append(execution, [
      runnerEventDraft({
        type: "task.failed",
        payload: {
          classification: "infrastructure",
          message: "Controlled failure.",
        },
      }),
    ]);
    const sender = new SequentialSpoolSender(store, {
      submitEvent: async () => ({
        ...response(committed!),
        acknowledgement: {
          ...response(committed!).acknowledgement,
          eventId: crypto.randomUUID(),
        },
      }),
    });

    await expect(sender.sendNext(execution)).rejects.toBeInstanceOf(
      RunnerDeliveryError,
    );
    await expect(store.pending(execution)).resolves.toEqual([committed]);
  });
});
