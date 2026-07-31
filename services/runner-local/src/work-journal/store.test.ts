import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runnerExecutionV1Schema,
  type RunnerTaskDeliveryV1,
} from "@socrates/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RunnerControlPlaneClient } from "../transport/client";
import { deliveryKeyFor } from "./codec";
import { WorkJournalError, type WorkJournalLimits } from "./contracts";
import { ExactClaimReconciler } from "./reconciler";
import {
  LocalWorkJournal,
  type WorkJournalFaultPoint,
  type WorkJournalIdentitySource,
} from "./store";
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
const limits: WorkJournalLimits = {
  maximumManifestBytes: 10_000,
  maximumClaimBytes: 1_000_000,
  maximumItems: 10,
  maximumJournalBytes: 10_000_000,
};
const roots: string[] = [];

function root(): string {
  const value = join(
    tmpdir(),
    `socrates-journal-${crypto.randomUUID().replaceAll("-", "")}`,
  );
  roots.push(value);
  return value;
}

function identities(): WorkJournalIdentitySource {
  return {
    attemptId: () => attemptId,
    now: () => new Date("2026-07-31T12:00:00.000Z"),
  };
}

async function open(rootPath: string): Promise<LocalWorkJournal> {
  return LocalWorkJournal.open({
    rootPath,
    limits,
    identitySource: identities(),
    directorySync: { sync: async () => undefined },
  });
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("LocalWorkJournal", () => {
  it.each([
    "before_temp_open",
    "after_temp_write",
    "after_temp_sync",
    "after_immutable_publish",
    "after_temp_unlink",
    "after_directory_sync",
  ] satisfies WorkJournalFaultPoint[])(
    "recovers admission after the %s fault boundary",
    async (faultPoint) => {
      const rootPath = root();
      let injected = false;
      const journal = await LocalWorkJournal.open({
        rootPath,
        limits,
        identitySource: identities(),
        directorySync: { sync: async () => undefined },
        injectFault: (point) => {
          if (!injected && point === faultPoint) {
            injected = true;
            throw new Error(`fault:${point}`);
          }
        },
      });
      await expect(journal.admit(delivery)).rejects.toThrow(
        `fault:${faultPoint}`,
      );
      const restarted = await open(rootPath);
      expect(await restarted.admit(delivery)).toMatchObject({
        attemptId,
        state: "pending_claim",
      });
      expect(await restarted.list()).toHaveLength(1);
    },
  );

  it.each([
    "before_temp_open",
    "after_temp_write",
    "after_temp_sync",
    "after_immutable_publish",
    "after_temp_unlink",
    "after_directory_sync",
  ] satisfies WorkJournalFaultPoint[])(
    "recovers rejection publication after the %s fault boundary",
    async (faultPoint) => {
      const rootPath = root();
      await (await open(rootPath)).admit(delivery);
      let injected = false;
      const faulting = await LocalWorkJournal.open({
        rootPath,
        limits,
        identitySource: identities(),
        directorySync: { sync: async () => undefined },
        injectFault: (point) => {
          if (!injected && point === faultPoint) {
            injected = true;
            throw new Error(`fault:${point}`);
          }
        },
      });
      const response = {
        status: 409 as const,
        apiCode: "resource_conflict" as const,
        requestId: "request-1",
      };
      await expect(
        faulting.commitRejection(delivery.deliveryId, response),
      ).rejects.toThrow(`fault:${faultPoint}`);
      const restarted = await open(rootPath);
      const state = await restarted.inspect(delivery.deliveryId);
      if (state?.state === "rejected") {
        expect(state.rejection).toMatchObject(response);
      } else {
        await expect(
          restarted.commitRejection(delivery.deliveryId, response),
        ).resolves.toMatchObject({ state: "rejected" });
      }
    },
  );

  it("keeps claim and rejection terminal records mutually exclusive", async () => {
    const claimed = await open(root());
    await claimed.admit(delivery);
    await claimed.commitClaim(delivery.deliveryId, execution);
    await expect(
      claimed.commitRejection(delivery.deliveryId, {
        status: 409,
        apiCode: "resource_conflict",
        requestId: "request-1",
      }),
    ).rejects.toMatchObject({ code: "identity_conflict" });

    const rejected = await open(root());
    await rejected.admit(delivery);
    await rejected.commitRejection(delivery.deliveryId, {
      status: 409,
      apiCode: "resource_conflict",
      requestId: "request-1",
    });
    await expect(
      rejected.commitClaim(delivery.deliveryId, execution),
    ).rejects.toMatchObject({ code: "identity_conflict" });
  });

  it("reuses one attempt across duplicate admission and restart", async () => {
    const rootPath = root();
    const first = await open(rootPath);
    expect(await first.admit(delivery)).toMatchObject({
      state: "pending_claim",
      attemptId,
    });
    const restarted = await open(rootPath);
    expect(await restarted.admit(delivery)).toEqual(
      await first.inspect(delivery.deliveryId),
    );
  });

  it("rejects reuse of a delivery ID for another task", async () => {
    const journal = await open(root());
    await journal.admit(delivery);
    await expect(
      journal.admit({
        ...delivery,
        taskId: "50000000-0000-4000-8000-000000000005",
      }),
    ).rejects.toMatchObject({ code: "identity_conflict" });
  });

  it("recovers an empty item directory left before publication", async () => {
    const rootPath = root();
    await mkdir(join(rootPath, "work", deliveryKeyFor(delivery)), {
      recursive: true,
    });
    const journal = await open(rootPath);
    expect(await journal.list()).toEqual([]);
    expect(await journal.admit(delivery)).toMatchObject({ attemptId });
  });

  it("fails closed on unexpected durable evidence", async () => {
    const rootPath = root();
    const journal = await open(rootPath);
    await journal.admit(delivery);
    await writeFile(
      join(rootPath, "work", deliveryKeyFor(delivery), "unknown.json"),
      "{}",
    );
    await expect(journal.inspect(delivery.deliveryId)).rejects.toBeInstanceOf(
      WorkJournalError,
    );
  });

  it("commits and reloads one immutable execution", async () => {
    const rootPath = root();
    const journal = await open(rootPath);
    await journal.admit(delivery);
    expect(await journal.commitClaim(delivery.deliveryId, execution)).toEqual(
      execution,
    );
    const restarted = await open(rootPath);
    expect(await restarted.claimedExecution(delivery.deliveryId)).toEqual(
      execution,
    );
    expect(await restarted.inspect(delivery.deliveryId)).toMatchObject({
      state: "claimed",
    });
  });

  it.each([
    "before_temp_open",
    "after_temp_write",
    "after_temp_sync",
    "after_immutable_publish",
    "after_temp_unlink",
    "after_directory_sync",
  ] satisfies WorkJournalFaultPoint[])(
    "recovers claim publication after the %s fault boundary",
    async (faultPoint) => {
      const rootPath = root();
      await (await open(rootPath)).admit(delivery);
      let injected = false;
      const faulting = await LocalWorkJournal.open({
        rootPath,
        limits,
        identitySource: identities(),
        directorySync: { sync: async () => undefined },
        injectFault: (point) => {
          if (!injected && point === faultPoint) {
            injected = true;
            throw new Error(`fault:${point}`);
          }
        },
      });
      await expect(
        faulting.commitClaim(delivery.deliveryId, execution),
      ).rejects.toThrow(`fault:${faultPoint}`);

      const restarted = await open(rootPath);
      const stored = await restarted.claimedExecution(delivery.deliveryId);
      if (stored) {
        expect(stored).toEqual(execution);
      } else {
        expect(
          await restarted.commitClaim(delivery.deliveryId, execution),
        ).toEqual(execution);
      }
    },
  );

  it("keeps the exact attempt pending when transport is ambiguous", async () => {
    const rootPath = root();
    const journal = await open(rootPath);
    const claimTaskDelivery = vi
      .fn()
      .mockRejectedValue(new Error("response lost"));
    const reconciler = new ExactClaimReconciler({
      journal,
      client: { claimTaskDelivery } as unknown as RunnerControlPlaneClient,
      leaseDurationMs: 60_000,
    });
    await expect(reconciler.reconcile(delivery)).rejects.toThrow(
      "response lost",
    );
    expect(claimTaskDelivery).toHaveBeenCalledWith(
      delivery.deliveryId,
      {
        version: "1",
        taskId: delivery.taskId,
        attemptId,
        leaseDurationMs: 60_000,
      },
      undefined,
    );
    expect(
      await (await open(rootPath)).inspect(delivery.deliveryId),
    ).toMatchObject({ state: "pending_claim", attemptId });
  });

  it("serializes concurrent reconciliation and reuses stored evidence", async () => {
    const rootPath = root();
    const journal = await open(rootPath);
    const claimTaskDelivery = vi.fn().mockResolvedValue(execution);
    const reconciler = new ExactClaimReconciler({
      journal,
      client: { claimTaskDelivery } as unknown as RunnerControlPlaneClient,
      leaseDurationMs: 60_000,
    });
    const [first, second] = await Promise.all([
      reconciler.reconcile(delivery),
      reconciler.reconcile(delivery),
    ]);
    expect(first).toEqual(execution);
    expect(second).toEqual(execution);
    expect(claimTaskDelivery).toHaveBeenCalledTimes(1);

    const noNetwork = vi.fn();
    const restarted = new ExactClaimReconciler({
      journal: await open(rootPath),
      client: {
        claimTaskDelivery: noNetwork,
      } as unknown as RunnerControlPlaneClient,
      leaseDurationMs: 60_000,
    });
    expect(await restarted.reconcile(delivery)).toEqual(execution);
    expect(noNetwork).not.toHaveBeenCalled();
  });

  it.each([
    "before_temp_open",
    "after_temp_write",
    "after_temp_sync",
    "after_immutable_publish",
    "after_temp_unlink",
    "after_directory_sync",
  ] satisfies WorkJournalFaultPoint[])(
    "recovers completion publication after the %s fault boundary",
    async (faultPoint) => {
      const rootPath = root();
      const initial = await open(rootPath);
      await initial.admit(delivery);
      await initial.commitClaim(delivery.deliveryId, execution);
      let injected = false;
      const faulting = await LocalWorkJournal.open({
        rootPath,
        limits,
        identitySource: identities(),
        directorySync: { sync: async () => undefined },
        injectFault: (point) => {
          if (!injected && point === faultPoint) {
            injected = true;
            throw new Error(`fault:${point}`);
          }
        },
      });
      const evidence = {
        attemptKey: "a".repeat(64),
        acknowledgedSequence: 3,
      };
      await expect(
        faulting.commitCompletion(delivery.deliveryId, execution, evidence),
      ).rejects.toThrow(`fault:${faultPoint}`);
      const restarted = await open(rootPath);
      const state = await restarted.inspect(delivery.deliveryId);
      if (state?.state === "completed") {
        expect(state.completion).toEqual(evidence);
      } else {
        await expect(
          restarted.commitCompletion(delivery.deliveryId, execution, evidence),
        ).resolves.toMatchObject({ state: "completed" });
      }
    },
  );

  it("requires the exact durable claim and completion evidence", async () => {
    const pending = await open(root());
    await pending.admit(delivery);
    await expect(
      pending.commitCompletion(delivery.deliveryId, execution, {
        attemptKey: "a".repeat(64),
        acknowledgedSequence: 3,
      }),
    ).rejects.toMatchObject({ code: "identity_conflict" });

    const completed = await open(root());
    await completed.admit(delivery);
    await completed.commitClaim(delivery.deliveryId, execution);
    await completed.commitCompletion(delivery.deliveryId, execution, {
      attemptKey: "a".repeat(64),
      acknowledgedSequence: 3,
    });
    await expect(
      completed.commitCompletion(delivery.deliveryId, execution, {
        attemptKey: "b".repeat(64),
        acknowledgedSequence: 3,
      }),
    ).rejects.toMatchObject({ code: "identity_conflict" });
    await expect(
      completed.commitRejection(delivery.deliveryId, {
        status: 409,
        apiCode: "resource_conflict",
        requestId: "request-after-completion",
      }),
    ).rejects.toMatchObject({ code: "identity_conflict" });
  });
});
