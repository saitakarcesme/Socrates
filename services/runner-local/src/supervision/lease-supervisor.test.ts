import {
  runnerExecutionV1Schema,
  type RunnerTaskHeartbeatResponseV1,
} from "@socrates/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  RunnerTransportError,
  type RunnerControlPlaneClient,
} from "../transport/client";
import { LeaseSupervisor } from "./lease-supervisor";
import taskFixture from "../../../../packages/contracts/fixtures/runner/task-v2.json";

const termination = Object.freeze({
  state: "terminated" as const,
  forced: true,
});

const execution = runnerExecutionV1Schema.parse({
  version: "1",
  lease: {
    version: "1",
    runnerId: "10000000-0000-4000-8000-000000000001",
    taskId: taskFixture.taskId,
    attemptId: "20000000-0000-4000-8000-000000000002",
    fence: 3,
    leasedUntil: "2026-07-31T18:00:00.000Z",
  },
  task: taskFixture,
});

function supervisor(options: {
  heartbeat: () => Promise<RunnerTaskHeartbeatResponseV1>;
  cancel?: ReturnType<typeof vi.fn>;
}) {
  const cancel = options.cancel ?? vi.fn(async () => termination);
  const heartbeat = vi.fn(options.heartbeat);
  const client = { heartbeat } as unknown as RunnerControlPlaneClient;
  return {
    cancel,
    heartbeat,
    value: new LeaseSupervisor({
      client,
      target: { cancel },
      leaseDurationMs: 30_000,
    }),
  };
}

describe("LeaseSupervisor", () => {
  it("renews the exact frozen execution without invoking cancellation", async () => {
    const fixture = supervisor({
      heartbeat: async () => ({
        version: "1",
        leaseExpiresAt: "2026-07-31T18:00:30.000Z",
        directive: "continue",
      }),
    });

    await expect(fixture.value.supervise(execution)).resolves.toEqual({
      state: "renewed",
      leaseExpiresAt: "2026-07-31T18:00:30.000Z",
    });
    expect(fixture.heartbeat).toHaveBeenCalledWith(
      {
        taskId: execution.lease.taskId,
        attemptId: execution.lease.attemptId,
        request: { version: "1", fence: 3, leaseDurationMs: 30_000 },
      },
      undefined,
    );
    expect(fixture.cancel).not.toHaveBeenCalled();
  });

  it("delivers the server-frozen cancellation policy with exact identity", async () => {
    const fixture = supervisor({
      heartbeat: async () => ({
        version: "1",
        leaseExpiresAt: "2026-07-31T18:00:30.000Z",
        directive: "cancel",
        cancellation: {
          requestedAt: "2026-07-31T17:59:59.000Z",
          gracePeriodMs: 2_500,
          reason: "budget",
        },
      }),
    });

    const result = await fixture.value.supervise(execution);
    expect(result).toMatchObject({
      state: "cancelled",
      cancellation: {
        runnerId: execution.lease.runnerId,
        taskId: execution.lease.taskId,
        attemptId: execution.lease.attemptId,
        fence: execution.lease.fence,
        gracePeriodMs: 2_500,
        reason: "budget",
      },
      termination,
    });
    expect(result.state === "cancelled" && result.termination).toBe(
      termination,
    );
    expect(fixture.cancel).toHaveBeenCalledOnce();
  });

  it("classifies only authenticated 409 conflicts as stale", async () => {
    const fixture = supervisor({
      heartbeat: async () => {
        throw new RunnerTransportError("conflict", "stale", {
          status: 409,
          apiCode: "resource_conflict",
          requestId: "request-1",
        });
      },
    });

    await expect(fixture.value.supervise(execution)).resolves.toEqual({
      state: "stale",
    });
    expect(fixture.cancel).not.toHaveBeenCalled();
  });

  it("propagates aborts and transport failures without cancelling", async () => {
    const failure = new RunnerTransportError("aborted", "aborted");
    const fixture = supervisor({
      heartbeat: async () => {
        throw failure;
      },
    });

    await expect(fixture.value.supervise(execution)).rejects.toBe(failure);
    expect(fixture.cancel).not.toHaveBeenCalled();
  });

  it("serializes concurrent supervision steps", async () => {
    let releaseFirst = () => undefined;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const fixture = supervisor({
      heartbeat: async () => {
        calls += 1;
        if (calls === 1) await firstPending;
        return {
          version: "1",
          leaseExpiresAt: "2026-07-31T18:00:30.000Z",
          directive: "continue",
        };
      },
    });

    const first = fixture.value.supervise(execution);
    const second = fixture.value.supervise(execution);
    await Promise.resolve();
    expect(fixture.heartbeat).toHaveBeenCalledTimes(1);
    releaseFirst();
    await Promise.all([first, second]);
    expect(fixture.heartbeat).toHaveBeenCalledTimes(2);
  });
});
