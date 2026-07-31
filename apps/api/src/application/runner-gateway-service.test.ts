import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import type {
  AcquireRunnerTaskDeliveryInput,
  ClaimRunnerTaskResult,
  HeartbeatRunnerTaskResult,
  IngestRunnerEventResult,
  Persistence,
  SchedulerRepository,
  TransactionRepositories,
} from "@socrates/database";

import { RunnerGatewayService } from "./runner-gateway-service";

const claimInput = {
  runnerId: randomUUID(),
  taskId: randomUUID(),
  attemptId: randomUUID(),
  leaseDurationMs: 30_000,
};

function serviceReturning(options: {
  claim?: ClaimRunnerTaskResult;
  event?: IngestRunnerEventResult;
  heartbeat?: HeartbeatRunnerTaskResult;
}): RunnerGatewayService {
  const scheduler = {
    claimTask: async () => {
      if (!options.claim) throw new Error("Unexpected claim.");
      return options.claim;
    },
    ingestEvent: async () => {
      if (!options.event) throw new Error("Unexpected event.");
      return options.event;
    },
    heartbeat: async () => {
      if (!options.heartbeat) throw new Error("Unexpected heartbeat.");
      return options.heartbeat;
    },
  } as unknown as SchedulerRepository;
  const persistence: Pick<Persistence, "transaction"> = {
    transaction: async <T>(
      work: (repositories: TransactionRepositories) => Promise<T>,
    ) => work({ scheduler } as TransactionRepositories),
  };
  return new RunnerGatewayService(persistence);
}

describe("RunnerGatewayService", () => {
  it("rejects untrusted or unbounded offer durations at construction", () => {
    const persistence = {
      transaction: async () => {
        throw new Error("Unexpected transaction.");
      },
    } as unknown as Pick<Persistence, "transaction">;
    for (const offerDurationMs of [0, -1, Number.MAX_SAFE_INTEGER]) {
      expect(
        () => new RunnerGatewayService(persistence, { offerDurationMs }),
      ).toThrow(RangeError);
    }
  });

  it("supplies the trusted offer duration instead of accepting runner input", async () => {
    const runnerId = randomUUID();
    const taskId = randomUUID();
    const deliveryId = randomUUID();
    let received: AcquireRunnerTaskDeliveryInput | undefined;
    const scheduler = {
      acquireTaskDelivery: async (input: AcquireRunnerTaskDeliveryInput) => {
        received = input;
        return {
          state: "acquired" as const,
          delivery: { deliveryId, taskId },
        };
      },
    } as unknown as SchedulerRepository;
    const persistence: Pick<Persistence, "transaction"> = {
      transaction: async <T>(
        work: (repositories: TransactionRepositories) => Promise<T>,
      ) => work({ scheduler } as TransactionRepositories),
    };
    const service = new RunnerGatewayService(persistence, {
      offerDurationMs: 45_000,
    });

    await expect(service.acquireTaskDelivery({ runnerId })).resolves.toEqual({
      deliveryId,
      taskId,
    });
    expect(received).toEqual({ runnerId, offerDurationMs: 45_000 });
  });

  it("preserves a successful fenced claim", async () => {
    const claim = {
      ...claimInput,
      fence: 3,
      leaseExpiresAt: new Date("2026-07-31T00:01:00.000Z"),
      payload: { version: "2" },
    };

    await expect(
      serviceReturning({
        claim: { state: "claimed", claim },
      }).claimTask(claimInput),
    ).resolves.toEqual(claim);
  });

  it("maps attempt identity reuse to an explicit conflict reason", async () => {
    await expect(
      serviceReturning({
        claim: { state: "attempt_conflict" },
      }).claimTask(claimInput),
    ).rejects.toMatchObject({
      status: 409,
      code: "resource_conflict",
      details: { runnerReason: "attempt_conflict" },
    });
  });

  it.each([
    "runner_unavailable",
    "runner_at_capacity",
    "task_unavailable",
    "capability_mismatch",
  ] as const)("maps %s to a resource conflict", async (state) => {
    await expect(
      serviceReturning({ claim: { state } }).claimTask(claimInput),
    ).rejects.toMatchObject({
      status: 409,
      code: "resource_conflict",
      details: { runnerReason: state },
    });
  });

  it.each(["runner_not_found", "task_not_found"] as const)(
    "maps %s without exposing a different resource",
    async (state) => {
      await expect(
        serviceReturning({ claim: { state } }).claimTask(claimInput),
      ).rejects.toMatchObject({
        status: 404,
        code: "not_found",
        details: { runnerReason: state },
      });
    },
  );

  it("preserves exact event replay as a successful acknowledgement", async () => {
    const acknowledgement = {
      eventId: randomUUID(),
      attemptId: claimInput.attemptId,
      acknowledgedSequence: 4,
      expectedSequence: 5,
      receivedAt: new Date("2026-07-31T00:00:10.000Z"),
    };

    await expect(
      serviceReturning({
        event: { state: "replay", acknowledgement },
      }).ingestEvent({ event: {} }),
    ).resolves.toEqual({ replay: true, acknowledgement });
  });

  it("preserves the database-clocked lease and cancellation directive", async () => {
    const leaseExpiresAt = new Date("2026-07-31T00:01:00.000Z");
    const requestedAt = new Date("2026-07-31T00:00:30.000Z");
    await expect(
      serviceReturning({
        heartbeat: {
          state: "renewed",
          leaseExpiresAt,
          directive: "cancel",
          cancellation: {
            requestedAt,
            gracePeriodMs: 2_500,
            reason: "budget",
          },
        },
      }).heartbeat({
        ...claimInput,
        fence: 3,
      }),
    ).resolves.toEqual({
      leaseExpiresAt,
      directive: "cancel",
      cancellation: { requestedAt, gracePeriodMs: 2_500, reason: "budget" },
    });
  });

  it("maps a stale heartbeat to a fenced resource conflict", async () => {
    await expect(
      serviceReturning({ heartbeat: { state: "stale" } }).heartbeat({
        ...claimInput,
        fence: 3,
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "resource_conflict",
      details: { runnerReason: "stale" },
    });
  });

  it("preserves the expected cursor for a sequence gap", async () => {
    await expect(
      serviceReturning({
        event: { state: "gap", expectedSequence: 7 },
      }).ingestEvent({ event: {} }),
    ).rejects.toMatchObject({
      status: 409,
      code: "resource_conflict",
      details: { runnerReason: "gap", expectedSequence: 7 },
    });
  });

  it("preserves bounded-evidence quota details", async () => {
    await expect(
      serviceReturning({
        event: {
          state: "budget_exhausted",
          dimension: "artifact_bytes",
          limitBytes: 1024,
          acceptedBytes: 1000,
          attemptedBytes: 25,
        },
      }).ingestEvent({ event: {} }),
    ).rejects.toMatchObject({
      status: 409,
      code: "budget_exhausted",
      details: {
        runnerReason: "budget_exhausted",
        dimension: "artifact_bytes",
        limitBytes: 1024,
        acceptedBytes: 1000,
        attemptedBytes: 25,
      },
    });
  });

  it.each([
    ["invalid_transition", 409, "invalid_transition"],
    ["invalid_evidence", 422, "protocol_mismatch"],
    ["unsupported_event", 422, "protocol_mismatch"],
    ["event_conflict", 409, "resource_conflict"],
    ["stale", 409, "resource_conflict"],
  ] as const)(
    "maps %s without erasing its scheduler reason",
    async (state, status, code) => {
      await expect(
        serviceReturning({ event: { state } }).ingestEvent({ event: {} }),
      ).rejects.toMatchObject({
        status,
        code,
        details: { runnerReason: state },
      });
    },
  );
});
