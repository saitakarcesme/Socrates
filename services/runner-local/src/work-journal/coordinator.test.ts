import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runnerExecutionV1Schema,
  type RunnerTaskDeliveryV1,
} from "@socrates/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RunnerTransportError,
  type RunnerControlPlaneClient,
} from "../transport/client";
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
    `socrates-admission-${crypto.randomUUID().replaceAll("-", "")}`,
  );
  roots.push(value);
  return value;
}

async function journal(rootPath = root()): Promise<LocalWorkJournal> {
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

function client(options: {
  acquire?: () => Promise<RunnerTaskDeliveryV1 | null>;
  claim?: () => Promise<typeof execution>;
}): RunnerControlPlaneClient {
  return {
    acquireTaskDelivery: options.acquire ?? (async () => null),
    claimTaskDelivery: options.claim ?? (async () => execution),
  } as RunnerControlPlaneClient;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("WorkAdmissionCoordinator", () => {
  it("returns idle after one acquire when local work is empty", async () => {
    const acquire = vi.fn().mockResolvedValue(null);
    const claim = vi.fn();
    const coordinator = new WorkAdmissionCoordinator({
      journal: await journal(),
      client: client({ acquire, claim }),
      leaseDurationMs: 60_000,
    });

    await expect(coordinator.prepareNext()).resolves.toEqual({ state: "idle" });
    expect(acquire).toHaveBeenCalledOnce();
    expect(claim).not.toHaveBeenCalled();
  });

  it("admits and claims one new delivery with its durable attempt", async () => {
    const acquire = vi.fn().mockResolvedValue(delivery);
    const claim = vi.fn().mockResolvedValue(execution);
    const coordinator = new WorkAdmissionCoordinator({
      journal: await journal(),
      client: client({ acquire, claim }),
      leaseDurationMs: 60_000,
    });

    await expect(coordinator.prepareNext()).resolves.toEqual({
      state: "ready",
      execution,
      recovered: false,
    });
    expect(claim).toHaveBeenCalledWith(
      delivery.deliveryId,
      {
        version: "1",
        taskId: delivery.taskId,
        attemptId,
        leaseDurationMs: 60_000,
      },
      undefined,
    );
  });

  it("recovers pending and claimed work before any acquire", async () => {
    const rootPath = root();
    const first = await journal(rootPath);
    await first.admit(delivery);
    const acquire = vi.fn();
    const claim = vi.fn().mockResolvedValue(execution);
    const pendingRecovery = new WorkAdmissionCoordinator({
      journal: await journal(rootPath),
      client: client({ acquire, claim }),
      leaseDurationMs: 60_000,
    });
    await expect(pendingRecovery.prepareNext()).resolves.toMatchObject({
      state: "ready",
      recovered: true,
    });
    expect(acquire).not.toHaveBeenCalled();
    expect(claim).toHaveBeenCalledOnce();

    const noNetworkAcquire = vi.fn();
    const noNetworkClaim = vi.fn();
    const claimedRecovery = new WorkAdmissionCoordinator({
      journal: await journal(rootPath),
      client: client({
        acquire: noNetworkAcquire,
        claim: noNetworkClaim,
      }),
      leaseDurationMs: 60_000,
    });
    await expect(claimedRecovery.prepareNext()).resolves.toEqual({
      state: "ready",
      execution,
      recovered: true,
    });
    expect(noNetworkAcquire).not.toHaveBeenCalled();
    expect(noNetworkClaim).not.toHaveBeenCalled();
  });

  it("durably rejects only an authoritative conflict and then permits acquire", async () => {
    const rootPath = root();
    const durable = await journal(rootPath);
    await durable.admit(delivery);
    const conflict = new RunnerTransportError("conflict", "conflict", {
      status: 409,
      apiCode: "resource_conflict",
      requestId: "request-1",
    });
    const claim = vi.fn().mockRejectedValue(conflict);
    const coordinator = new WorkAdmissionCoordinator({
      journal: durable,
      client: client({ acquire: vi.fn(), claim }),
      leaseDurationMs: 60_000,
    });
    await expect(coordinator.prepareNext()).resolves.toMatchObject({
      state: "rejected",
      recovered: true,
      work: {
        state: "rejected",
        rejection: {
          reason: "control_plane_conflict",
          status: 409,
          apiCode: "resource_conflict",
          requestId: "request-1",
        },
      },
    });

    const acquireAfterRestart = vi.fn().mockResolvedValue(null);
    const noClaim = vi.fn();
    const restarted = new WorkAdmissionCoordinator({
      journal: await journal(rootPath),
      client: client({ acquire: acquireAfterRestart, claim: noClaim }),
      leaseDurationMs: 60_000,
    });
    await expect(restarted.prepareNext()).resolves.toEqual({ state: "idle" });
    expect(acquireAfterRestart).toHaveBeenCalledOnce();
    expect(noClaim).not.toHaveBeenCalled();
  });

  it("leaves pending work unchanged after a non-authoritative failure", async () => {
    const durable = await journal();
    await durable.admit(delivery);
    const coordinator = new WorkAdmissionCoordinator({
      journal: durable,
      client: client({
        claim: vi.fn().mockRejectedValue(new Error("network")),
      }),
      leaseDurationMs: 60_000,
    });
    await expect(coordinator.prepareNext()).rejects.toThrow("network");
    await expect(durable.inspect(delivery.deliveryId)).resolves.toMatchObject({
      state: "pending_claim",
      attemptId,
    });
  });

  it("serializes concurrent preparation into one acquire and one claim", async () => {
    const acquire = vi.fn().mockResolvedValue(delivery);
    const claim = vi.fn().mockResolvedValue(execution);
    const coordinator = new WorkAdmissionCoordinator({
      journal: await journal(),
      client: client({ acquire, claim }),
      leaseDurationMs: 60_000,
    });
    const [first, second] = await Promise.all([
      coordinator.prepareNext(),
      coordinator.prepareNext(),
    ]);
    expect(first).toMatchObject({ state: "ready", recovered: false });
    expect(second).toMatchObject({ state: "ready", recovered: true });
    expect(acquire).toHaveBeenCalledOnce();
    expect(claim).toHaveBeenCalledOnce();
  });
});
