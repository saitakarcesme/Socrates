import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runnerExecutionV1Schema,
  type RunnerAttemptReconcileResponseV1,
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
const noTerminalRecovery = {
  recover: async () => Object.freeze({ state: "none" as const }),
};

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
  reconcile?: () => Promise<RunnerAttemptReconcileResponseV1>;
}): RunnerControlPlaneClient {
  return {
    acquireTaskDelivery: options.acquire ?? (async () => null),
    claimTaskDelivery: options.claim ?? (async () => execution),
    reconcileAttempt:
      options.reconcile ??
      (async () => ({
        version: "1",
        state: "current",
        observedAt: "2026-07-31T12:00:00.000Z",
        leaseExpiresAt: "2026-07-31T12:01:00.000Z",
      })),
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
      terminalRecovery: noTerminalRecovery,
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
      terminalRecovery: noTerminalRecovery,
    });

    await expect(coordinator.prepareNext()).resolves.toEqual({
      state: "ready",
      deliveryId: delivery.deliveryId,
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
      terminalRecovery: noTerminalRecovery,
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
      terminalRecovery: noTerminalRecovery,
    });
    await expect(claimedRecovery.prepareNext()).resolves.toEqual({
      state: "ready",
      deliveryId: delivery.deliveryId,
      execution,
      recovered: true,
    });
    expect(noNetworkAcquire).not.toHaveBeenCalled();
    expect(noNetworkClaim).not.toHaveBeenCalled();
  });

  it("recovers claimed terminal evidence before returning ready", async () => {
    const rootPath = root();
    const durable = await journal(rootPath);
    await durable.admit(delivery);
    const claimed = await durable.commitClaim(delivery.deliveryId, execution);
    const completed = Object.freeze({
      ...claimed,
      state: "completed" as const,
      completedAt: "2026-07-31T12:00:02.000Z",
      completion: {
        attemptKey: "a".repeat(64),
        acknowledgedSequence: 1,
      },
    });
    const recover = vi.fn(async () => ({
      state: "completed" as const,
      work: completed,
    }));
    const acquire = vi.fn();
    const claim = vi.fn();
    const coordinator = new WorkAdmissionCoordinator({
      journal: await journal(rootPath),
      client: client({ acquire, claim }),
      leaseDurationMs: 60_000,
      terminalRecovery: { recover },
    });

    await expect(coordinator.prepareNext()).resolves.toEqual({
      state: "completed",
      execution,
      work: completed,
      recovered: true,
    });
    expect(recover).toHaveBeenCalledWith(delivery.deliveryId, execution);
    expect(acquire).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
  });

  it("keeps claimed recovery ambiguity from releasing execution", async () => {
    const rootPath = root();
    const durable = await journal(rootPath);
    await durable.admit(delivery);
    await durable.commitClaim(delivery.deliveryId, execution);
    const failure = new Error("pre-start evidence delivery ambiguous");
    const acquire = vi.fn();
    const claim = vi.fn();
    const recover = vi.fn(async () => Promise.reject(failure));
    const coordinator = new WorkAdmissionCoordinator({
      journal: await journal(rootPath),
      client: client({ acquire, claim }),
      leaseDurationMs: 60_000,
      terminalRecovery: { recover },
    });

    await expect(coordinator.prepareNext()).rejects.toBe(failure);
    expect(recover).toHaveBeenCalledWith(delivery.deliveryId, execution);
    expect(acquire).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
  });

  it("keeps a server-current started execution indeterminate", async () => {
    const rootPath = root();
    const durable = await journal(rootPath);
    await durable.admit(delivery);
    await durable.commitClaim(delivery.deliveryId, execution);
    const started = await durable.commitExecutionStart(
      delivery.deliveryId,
      execution,
    );
    const acquire = vi.fn();
    const claim = vi.fn();
    const recovered = new WorkAdmissionCoordinator({
      journal: await journal(rootPath),
      client: client({ acquire, claim }),
      leaseDurationMs: 60_000,
      terminalRecovery: noTerminalRecovery,
    });

    await expect(recovered.prepareNext()).resolves.toEqual({
      state: "indeterminate",
      execution,
      work: started,
      recovered: true,
      observedAt: "2026-07-31T12:00:00.000Z",
      leaseExpiresAt: "2026-07-31T12:01:00.000Z",
    });
    expect(acquire).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
  });

  it("returns recovered terminal completion before reconciliation or acquisition", async () => {
    const rootPath = root();
    const durable = await journal(rootPath);
    await durable.admit(delivery);
    await durable.commitClaim(delivery.deliveryId, execution);
    const started = await durable.commitExecutionStart(
      delivery.deliveryId,
      execution,
    );
    const completed = Object.freeze({
      ...started,
      state: "completed" as const,
      completedAt: "2026-07-31T12:00:02.000Z",
      completion: {
        attemptKey: "a".repeat(64),
        acknowledgedSequence: 2,
      },
    });
    const recover = vi.fn(async () => ({
      state: "completed" as const,
      work: completed,
    }));
    const reconcile = vi.fn();
    const acquire = vi.fn();
    const coordinator = new WorkAdmissionCoordinator({
      journal: await journal(rootPath),
      client: client({ acquire, reconcile }),
      leaseDurationMs: 60_000,
      terminalRecovery: { recover },
    });

    await expect(coordinator.prepareNext()).resolves.toEqual({
      state: "completed",
      execution,
      work: completed,
      recovered: true,
    });
    expect(recover).toHaveBeenCalledWith(delivery.deliveryId, execution);
    expect(reconcile).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
  });

  it("preserves recovery ambiguity without reconciling the lease", async () => {
    const rootPath = root();
    const durable = await journal(rootPath);
    await durable.admit(delivery);
    await durable.commitClaim(delivery.deliveryId, execution);
    await durable.commitExecutionStart(delivery.deliveryId, execution);
    const failure = new Error("event delivery ambiguous");
    const reconcile = vi.fn();
    const acquire = vi.fn();
    const coordinator = new WorkAdmissionCoordinator({
      journal: await journal(rootPath),
      client: client({ acquire, reconcile }),
      leaseDurationMs: 60_000,
      terminalRecovery: {
        recover: vi.fn(async () => Promise.reject(failure)),
      },
    });

    await expect(coordinator.prepareNext()).rejects.toBe(failure);
    expect(reconcile).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
  });

  it("durably retires a server-retired start before later acquisition", async () => {
    const rootPath = root();
    const durable = await journal(rootPath);
    await durable.admit(delivery);
    await durable.commitClaim(delivery.deliveryId, execution);
    await durable.commitExecutionStart(delivery.deliveryId, execution);
    const acquire = vi.fn();
    const reconcile = vi.fn().mockResolvedValue({
      version: "1",
      state: "retired",
      observedAt: "2026-07-31T12:02:00.000Z",
      reason: "lease_expired_requeued",
    });
    const coordinator = new WorkAdmissionCoordinator({
      journal: await journal(rootPath),
      client: client({ acquire, reconcile }),
      leaseDurationMs: 60_000,
      terminalRecovery: noTerminalRecovery,
    });

    await expect(coordinator.prepareNext()).resolves.toMatchObject({
      state: "retired",
      recovered: true,
      work: {
        state: "retired",
        retirement: {
          observedAt: "2026-07-31T12:02:00.000Z",
          reason: "lease_expired_requeued",
        },
      },
    });
    expect(reconcile).toHaveBeenCalledOnce();
    expect(acquire).not.toHaveBeenCalled();

    const acquireLater = vi.fn().mockResolvedValue(null);
    const noReconcile = vi.fn();
    const restarted = new WorkAdmissionCoordinator({
      journal: await journal(rootPath),
      client: client({ acquire: acquireLater, reconcile: noReconcile }),
      leaseDurationMs: 60_000,
      terminalRecovery: noTerminalRecovery,
    });
    await expect(restarted.prepareNext()).resolves.toEqual({ state: "idle" });
    expect(acquireLater).toHaveBeenCalledOnce();
    expect(noReconcile).not.toHaveBeenCalled();
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
      terminalRecovery: noTerminalRecovery,
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
      terminalRecovery: noTerminalRecovery,
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
      terminalRecovery: noTerminalRecovery,
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
      terminalRecovery: noTerminalRecovery,
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
