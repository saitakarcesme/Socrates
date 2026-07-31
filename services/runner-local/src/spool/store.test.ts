import { readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runnerExecutionV1Schema } from "@socrates/contracts";
import { canonicalJson } from "@socrates/runtime-protocol";
import { afterEach, describe, expect, it } from "vitest";

import { runnerEventDraft, type RunnerEventDraft } from "../lifecycle/draft";
import { attemptKeyFor } from "./codec";
import { SpoolError, type SpoolLimits } from "./contracts";
import type { DirectorySync, SpoolFaultPoint } from "./filesystem";
import { LocalEventSpool, type SpoolIdentitySource } from "./store";
import taskFixture from "../../../../packages/contracts/fixtures/runner/task-v2.json";

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
  maximumEventsPerSegment: 100,
  maximumAttempts: 10,
  maximumSpoolBytes: 10_000_000,
};

const noDirectorySync: DirectorySync = { sync: async () => undefined };
const roots: string[] = [];

function root(): string {
  const value = join(
    tmpdir(),
    `socrates-spool-${crypto.randomUUID().replaceAll("-", "")}`,
  );
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

function drafts(terminal = true): readonly RunnerEventDraft[] {
  const values: RunnerEventDraft[] = [
    runnerEventDraft({
      type: "workspace.prepared",
      payload: {
        sourceDigest: execution.task.source.digest,
        imageDigest: execution.task.environment.imageDigest,
      },
    }),
    runnerEventDraft({
      type: "action.started",
      payload: { commandIndex: 0 },
    }),
  ];
  if (terminal) {
    values.push(
      runnerEventDraft({
        type: "task.failed",
        payload: {
          classification: "infrastructure",
          message: "Fixed failure.",
        },
      }),
    );
  }
  return Object.freeze(values);
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
    receivedAt: "2026-07-31T12:00:01.000Z",
  };
}

async function open(
  rootPath: string,
  options: {
    source?: SpoolIdentitySource;
    injectFault?: (point: SpoolFaultPoint) => void | Promise<void>;
    configuredLimits?: SpoolLimits;
  } = {},
): Promise<LocalEventSpool> {
  return LocalEventSpool.open({
    rootPath,
    limits: options.configuredLimits ?? limits,
    identitySource: options.source ?? identities(),
    directorySync: noDirectorySync,
    injectFault: options.injectFault,
  });
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("local event spool", () => {
  it("inspects an absent attempt without creating spool state", async () => {
    const rootPath = root();
    const spool = await open(rootPath);
    const attemptsPath = join(rootPath, "attempts");
    const before = await readdir(attemptsPath);

    await expect(spool.inspectExisting(execution)).resolves.toBeNull();
    expect(await readdir(attemptsPath)).toEqual(before);
  });

  it("recovers a committed batch byte-identically after restart", async () => {
    const rootPath = root();
    const first = await open(rootPath);
    const committed = await first.append(execution, drafts());

    expect(committed.map(({ sequence }) => sequence)).toEqual([1, 2, 3]);
    expect(new Set(committed.map(({ eventId }) => eventId)).size).toBe(3);
    expect(
      committed.every(
        ({ occurredAt }) => occurredAt === committed[0]?.occurredAt,
      ),
    ).toBe(true);

    const restarted = await open(rootPath, {
      source: {
        eventId: () => {
          throw new Error("Recovery must not allocate an event ID.");
        },
        now: () => {
          throw new Error("Recovery must not read the clock.");
        },
      },
    });
    await expect(restarted.pending(execution)).resolves.toEqual(committed);
    expect(
      Object.isFrozen((await restarted.pending(execution))[0]?.payload),
    ).toBe(true);
  });

  it("advances exact acknowledgements monotonically and retains a terminal tombstone", async () => {
    const rootPath = root();
    const spool = await open(rootPath);
    const events = await spool.append(execution, drafts());

    for (const [index, event] of events.entries()) {
      const state = await spool.acknowledge(execution, acknowledgement(event));
      expect(state.acknowledgedSequence).toBe(index + 1);
      expect(state.pendingEvents).toBe(events.length - index - 1);
    }

    const finalAcknowledgement = acknowledgement(events.at(-1)!);
    await expect(
      spool.acknowledge(execution, finalAcknowledgement),
    ).resolves.toMatchObject({ terminal: true, pendingEvents: 0 });

    const restarted = await open(rootPath);
    await expect(restarted.pending(execution)).resolves.toEqual([]);
    await expect(restarted.inspect(execution)).resolves.toMatchObject({
      acknowledgedSequence: 3,
      lastSequence: 3,
      terminal: true,
    });
    await expect(
      restarted.append(execution, drafts(false)),
    ).rejects.toMatchObject({
      code: "terminal",
    });
  });

  it("rejects acknowledgement gaps and conflicting event identity without advancing", async () => {
    const spool = await open(root());
    const events = await spool.append(execution, drafts());
    const second = events[1]!;

    await expect(
      spool.acknowledge(execution, acknowledgement(second)),
    ).rejects.toMatchObject({ code: "acknowledgement_conflict" });
    await expect(
      spool.acknowledge(execution, {
        ...acknowledgement(events[0]!),
        eventId: "40000000-0000-4000-8000-000000000004",
      }),
    ).rejects.toMatchObject({ code: "acknowledgement_conflict" });
    await expect(spool.inspect(execution)).resolves.toMatchObject({
      acknowledgedSequence: 0,
      pendingEvents: 3,
    });
  });

  it("serializes concurrent appends and admits only one closed batch", async () => {
    const spool = await open(root());
    const results = await Promise.allSettled([
      spool.append(execution, drafts()),
      spool.append(execution, drafts()),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(
      1,
    );
    await expect(spool.pending(execution)).resolves.toHaveLength(3);
  });

  it("binds an attempt key to the complete frozen execution digest", async () => {
    const rootPath = root();
    const spool = await open(rootPath);
    await spool.append(execution, drafts());
    const altered = runnerExecutionV1Schema.parse({
      ...execution,
      task: { ...execution.task, hypothesis: "Altered after the attempt." },
    });

    await expect(spool.inspect(altered)).rejects.toMatchObject({
      code: "identity_conflict",
    });
  });

  it("enforces event and encoded-byte capacity before publication", async () => {
    const eventLimited = await open(root(), {
      configuredLimits: { ...limits, maximumEventsPerSegment: 1 },
    });
    await expect(
      eventLimited.append(execution, drafts()),
    ).rejects.toMatchObject({ code: "capacity_exceeded" });
    await expect(eventLimited.pending(execution)).resolves.toEqual([]);

    const byteLimited = await open(root(), {
      configuredLimits: {
        ...limits,
        maximumSegmentBytes: 1,
        maximumSpoolBytes: 10_000,
      },
    });
    await expect(byteLimited.append(execution, drafts())).rejects.toMatchObject(
      { code: "capacity_exceeded" },
    );
  });

  it("recovers a whole segment when a fault follows immutable publication", async () => {
    const rootPath = root();
    let armed = false;
    const spool = await open(rootPath, {
      injectFault: (point) => {
        if (armed && point === "after_immutable_publish") {
          armed = false;
          throw new Error("injected crash");
        }
      },
    });
    await spool.inspect(execution);
    armed = true;
    await expect(spool.append(execution, drafts())).rejects.toThrow(
      "injected crash",
    );

    const restarted = await open(rootPath);
    await expect(restarted.pending(execution)).resolves.toHaveLength(3);
  });

  it.each([
    ["before_temp_open", 0],
    ["after_temp_write", 0],
    ["after_temp_sync", 0],
    ["after_immutable_publish", 3],
    ["after_temp_unlink", 3],
    ["after_directory_sync", 3],
  ] as const)(
    "recovers an all-or-nothing batch after the %s fault boundary",
    async (faultPoint, expectedEvents) => {
      const rootPath = root();
      let armed = false;
      const spool = await open(rootPath, {
        injectFault: (point) => {
          if (armed && point === faultPoint) {
            armed = false;
            throw new Error(`fault:${point}`);
          }
        },
      });
      await spool.inspect(execution);
      armed = true;
      await expect(spool.append(execution, drafts())).rejects.toThrow(
        `fault:${faultPoint}`,
      );

      const restarted = await open(rootPath);
      await expect(restarted.pending(execution)).resolves.toHaveLength(
        expectedEvents,
      );
    },
  );

  it("discards temporary debris when a fault precedes immutable publication", async () => {
    const rootPath = root();
    let armed = false;
    const spool = await open(rootPath, {
      injectFault: (point) => {
        if (armed && point === "after_temp_sync") {
          armed = false;
          throw new Error("injected crash");
        }
      },
    });
    await spool.inspect(execution);
    armed = true;
    await expect(spool.append(execution, drafts())).rejects.toThrow(
      "injected crash",
    );

    const restarted = await open(rootPath);
    await expect(restarted.pending(execution)).resolves.toEqual([]);
  });

  it("recovers an acknowledgement renamed before an injected crash", async () => {
    const rootPath = root();
    let armed = false;
    const spool = await open(rootPath, {
      injectFault: (point) => {
        if (armed && point === "after_replace") {
          armed = false;
          throw new Error("injected crash");
        }
      },
    });
    const events = await spool.append(execution, drafts());
    armed = true;
    await expect(
      spool.acknowledge(execution, acknowledgement(events[0]!)),
    ).rejects.toThrow("injected crash");

    const restarted = await open(rootPath);
    await expect(restarted.inspect(execution)).resolves.toMatchObject({
      acknowledgedSequence: 1,
      pendingEvents: 2,
    });
  });

  it.each([
    ["before_temp_open", 0],
    ["after_temp_write", 0],
    ["after_temp_sync", 0],
    ["after_replace", 1],
    ["after_directory_sync", 1],
  ] as const)(
    "recovers a monotonic cursor after the acknowledgement %s boundary",
    async (faultPoint, expectedAcknowledgedSequence) => {
      const rootPath = root();
      let armed = false;
      const spool = await open(rootPath, {
        injectFault: (point) => {
          if (armed && point === faultPoint) {
            armed = false;
            throw new Error(`fault:${point}`);
          }
        },
      });
      const events = await spool.append(execution, drafts());
      armed = true;
      await expect(
        spool.acknowledge(execution, acknowledgement(events[0]!)),
      ).rejects.toThrow(`fault:${faultPoint}`);

      const restarted = await open(rootPath);
      await expect(restarted.inspect(execution)).resolves.toMatchObject({
        acknowledgedSequence: expectedAcknowledgedSequence,
        pendingEvents: 3 - expectedAcknowledgedSequence,
      });
    },
  );

  it("fails closed when canonical segment bytes are corrupted", async () => {
    const rootPath = root();
    const spool = await open(rootPath);
    await spool.append(execution, drafts());
    const key = attemptKeyFor(execution);
    const segmentPath = join(
      rootPath,
      "attempts",
      key,
      "segments",
      "0000000000000001-0000000000000003.json",
    );
    const bytes = await readFile(segmentPath);
    bytes[10] = bytes[10] === 97 ? 98 : 97;
    await writeFile(segmentPath, bytes);

    const restarted = await open(rootPath);
    await expect(restarted.pending(execution)).rejects.toMatchObject({
      code: "corrupt",
    });
  });

  it("rejects non-canonical segment JSON and checksum substitution", async () => {
    const nonCanonicalRoot = root();
    const first = await open(nonCanonicalRoot);
    await first.append(execution, drafts());
    const key = attemptKeyFor(execution);
    const relative = join(
      "attempts",
      key,
      "segments",
      "0000000000000001-0000000000000003.json",
    );
    const nonCanonicalPath = join(nonCanonicalRoot, relative);
    const parsed = JSON.parse(
      await readFile(nonCanonicalPath, "utf8"),
    ) as unknown;
    await writeFile(nonCanonicalPath, JSON.stringify(parsed, null, 2));
    await expect(
      (await open(nonCanonicalRoot)).pending(execution),
    ).rejects.toMatchObject({
      code: "corrupt",
    });

    const checksumRoot = root();
    const second = await open(checksumRoot);
    await second.append(execution, drafts());
    const checksumPath = join(checksumRoot, relative);
    const segment = JSON.parse(await readFile(checksumPath, "utf8")) as {
      checksum: string;
    };
    segment.checksum = `sha256:${"0".repeat(64)}`;
    await writeFile(checksumPath, canonicalJson(segment));
    await expect(
      (await open(checksumRoot)).pending(execution),
    ).rejects.toMatchObject({
      code: "corrupt",
    });
  });

  it("fails closed when a durable segment gap is introduced", async () => {
    const rootPath = root();
    const spool = await open(rootPath);
    await spool.append(execution, drafts());
    const key = attemptKeyFor(execution);
    await unlink(
      join(
        rootPath,
        "attempts",
        key,
        "segments",
        "0000000000000001-0000000000000003.json",
      ),
    );

    const restarted = await open(rootPath);
    await expect(restarted.pending(execution)).rejects.toMatchObject({
      code: "corrupt",
    });
  });

  it("rejects duplicate allocated IDs, invalid clocks, and attempt exhaustion", async () => {
    const duplicateIds = await open(root(), {
      source: {
        eventId: () => "30000000-0000-4000-8000-000000000001",
        now: () => new Date("2026-07-31T12:00:00.000Z"),
      },
    });
    await expect(
      duplicateIds.append(execution, drafts()),
    ).rejects.toMatchObject({
      code: "corrupt",
    });

    const invalidClock = await open(root(), {
      source: { eventId: crypto.randomUUID, now: () => new Date(Number.NaN) },
    });
    await expect(invalidClock.inspect(execution)).rejects.toMatchObject({
      code: "corrupt",
    });

    const attemptLimited = await open(root(), {
      configuredLimits: { ...limits, maximumAttempts: 1 },
    });
    await attemptLimited.inspect(execution);
    const nextAttempt = runnerExecutionV1Schema.parse({
      ...execution,
      lease: {
        ...execution.lease,
        attemptId: "50000000-0000-4000-8000-000000000005",
      },
    });
    await expect(attemptLimited.inspect(nextAttempt)).rejects.toMatchObject({
      code: "capacity_exceeded",
    });
  });

  it("rejects unexpected root entries instead of traversing them", async () => {
    const rootPath = root();
    await open(rootPath);
    await writeFile(join(rootPath, "foreign.txt"), "not spool state");

    await expect(open(rootPath)).rejects.toMatchObject({ code: "corrupt" });
  });

  it("exposes typed spool failures", () => {
    expect(new SpoolError("capacity_exceeded", "bounded")).toMatchObject({
      name: "SpoolError",
      code: "capacity_exceeded",
    });
  });
});
