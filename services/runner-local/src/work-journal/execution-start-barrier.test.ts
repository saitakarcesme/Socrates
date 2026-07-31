import { runnerExecutionV1Schema } from "@socrates/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  DurableExecutionStartBarrier,
  DurableExecutionStartBarrierError,
  type ExecutionStartJournal,
} from "./execution-start-barrier";
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

function state(
  current: WorkJournalState["state"] = "execution_started",
): WorkJournalState {
  return {
    deliveryId,
    taskId: execution.lease.taskId,
    attemptId: execution.lease.attemptId,
    state: current,
    admittedAt: "2026-07-31T21:00:00.000Z",
    claimedAt: "2026-07-31T21:00:01.000Z",
    executionStartedAt:
      current === "execution_started" ? "2026-07-31T21:00:02.000Z" : undefined,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("DurableExecutionStartBarrier", () => {
  it("binds and freezes exact delivery and execution identity", async () => {
    const candidate = structuredClone(execution);
    const commitExecutionStart = vi.fn(async () => state());
    const barrier = new DurableExecutionStartBarrier({
      journal: { commitExecutionStart },
      deliveryId,
      execution: candidate,
    });
    candidate.lease.fence = 9;

    await expect(barrier.cross()).resolves.toBeUndefined();
    expect(commitExecutionStart).toHaveBeenCalledOnce();
    const [observedDelivery, observedExecution] =
      commitExecutionStart.mock.calls[0]!;
    expect(observedDelivery).toBe(deliveryId);
    expect(observedExecution.lease.fence).toBe(3);
    expect(Object.isFrozen(observedExecution)).toBe(true);
    expect(Object.isFrozen(observedExecution.task)).toBe(true);
  });

  it("rejects invalid identity before journal access", () => {
    const journal: ExecutionStartJournal = {
      commitExecutionStart: vi.fn(async () => state()),
    };

    expect(
      () =>
        new DurableExecutionStartBarrier({
          journal,
          deliveryId: "not-a-delivery-id",
          execution,
        }),
    ).toThrow();
    expect(
      () =>
        new DurableExecutionStartBarrier({
          journal,
          deliveryId,
          execution: {
            ...execution,
            lease: { ...execution.lease, fence: 0 },
          },
        }),
    ).toThrow();
    expect(journal.commitExecutionStart).not.toHaveBeenCalled();
  });

  it("shares one concurrent and sequential crossing", async () => {
    const publication = deferred<WorkJournalState>();
    const commitExecutionStart = vi.fn(() => publication.promise);
    const barrier = new DurableExecutionStartBarrier({
      journal: { commitExecutionStart },
      deliveryId,
      execution,
    });

    const first = barrier.cross();
    expect(barrier.cross()).toBe(first);
    expect(commitExecutionStart).toHaveBeenCalledOnce();
    publication.resolve(state());
    await first;
    expect(barrier.cross()).toBe(first);
    await expect(barrier.cross()).resolves.toBeUndefined();
    expect(commitExecutionStart).toHaveBeenCalledOnce();
  });

  it("replays an uncertain first publication without retrying", async () => {
    const failure = new Error("directory sync uncertain");
    const commitExecutionStart = vi.fn(async () => Promise.reject(failure));
    const barrier = new DurableExecutionStartBarrier({
      journal: { commitExecutionStart },
      deliveryId,
      execution,
    });

    const first = barrier.cross();
    await expect(first).rejects.toBe(failure);
    expect(barrier.cross()).toBe(first);
    await expect(barrier.cross()).rejects.toBe(failure);
    expect(commitExecutionStart).toHaveBeenCalledOnce();
  });

  it.each(["claimed", "completed", "retired", "rejected"] as const)(
    "fails closed on unexpected %s journal state",
    async (current) => {
      const commitExecutionStart = vi.fn(async () => state(current));
      const barrier = new DurableExecutionStartBarrier({
        journal: { commitExecutionStart },
        deliveryId,
        execution,
      });

      const crossing = barrier.cross();
      await expect(crossing).rejects.toMatchObject<
        Partial<DurableExecutionStartBarrierError>
      >({ code: "unexpected_state" });
      expect(barrier.cross()).toBe(crossing);
      expect(commitExecutionStart).toHaveBeenCalledOnce();
    },
  );
});
