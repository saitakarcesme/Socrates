import { runnerExecutionV1Schema } from "@socrates/contracts";
import { describe, expect, it, vi } from "vitest";

import taskFixture from "../../../../packages/contracts/fixtures/runner/task-v2.json";
import { LeaseAuthorityMonitor } from "./lease-authority-monitor";
import {
  NodeAttemptTimingError,
  NodeLeaseAuthorityScheduler,
  type NodeTimerDriver,
} from "./node-scheduler";

type ScheduledTimer = {
  callback: () => void;
  delayMs: number;
  handle: Readonly<{ id: number; unref: ReturnType<typeof vi.fn> }>;
};

class FakeTimerDriver implements NodeTimerDriver {
  readonly timers: ScheduledTimer[] = [];
  readonly schedule = vi.fn((callback: () => void, delayMs: number) => {
    const handle = Object.freeze({ id: this.timers.length, unref: vi.fn() });
    this.timers.push({ callback, delayMs, handle });
    return handle;
  });
  readonly cancel = vi.fn((handle: unknown) => {
    void handle;
  });

  fire(index = 0): void {
    this.timers[index]?.callback();
  }
}

describe("NodeLeaseAuthorityScheduler", () => {
  it("constructs without scheduling and captures the driver methods", async () => {
    const driver = new FakeTimerDriver();
    const scheduler = new NodeLeaseAuthorityScheduler(driver);
    expect(driver.schedule).not.toHaveBeenCalled();
    expect(driver.cancel).not.toHaveBeenCalled();

    const capturedSchedule = driver.schedule;
    Object.defineProperty(driver, "schedule", {
      value: vi.fn(() => {
        throw new Error("mutated");
      }),
    });
    const waiting = scheduler.wait(1, new AbortController().signal);
    expect(capturedSchedule).toHaveBeenCalledOnce();
    driver.fire();
    await expect(waiting).resolves.toBeUndefined();
  });

  it.each([null, {}, { schedule: vi.fn() }, { cancel: vi.fn() }])(
    "rejects malformed driver %# with a fixed construction error",
    (driver) => {
      expect(
        () => new NodeLeaseAuthorityScheduler(driver as never),
      ).toThrowError(NodeAttemptTimingError);
      try {
        new NodeLeaseAuthorityScheduler(driver as never);
      } catch (error) {
        expect(error).toMatchObject({
          code: "invalid_driver",
          message: "Node timer driver is invalid.",
        });
      }
    },
  );

  it("redacts a throwing driver accessor while retaining its cause", () => {
    const cause = new Error("private driver details");
    const driver = Object.defineProperty({}, "schedule", {
      get: () => {
        throw cause;
      },
    });

    try {
      new NodeLeaseAuthorityScheduler(driver as NodeTimerDriver);
      throw new Error("Expected construction to fail.");
    } catch (error) {
      expect(error).toMatchObject({
        code: "invalid_driver",
        cause,
        message: "Node timer driver is invalid.",
      });
      expect(String(error)).not.toContain("private driver details");
    }
  });

  it.each([Number.NaN, Number.NEGATIVE_INFINITY, 0, -1, 1.5, 2_147_483_648])(
    "rejects invalid delay %s without touching the driver",
    async (delayMs) => {
      const driver = new FakeTimerDriver();
      const scheduler = new NodeLeaseAuthorityScheduler(driver);

      await expect(
        scheduler.wait(delayMs, new AbortController().signal),
      ).rejects.toMatchObject({ code: "invalid_wait" });
      expect(driver.schedule).not.toHaveBeenCalled();
    },
  );

  it("rejects a non-AbortSignal without touching the driver", async () => {
    const driver = new FakeTimerDriver();
    const scheduler = new NodeLeaseAuthorityScheduler(driver);

    await expect(scheduler.wait(1, {} as AbortSignal)).rejects.toMatchObject({
      code: "invalid_wait",
    });
    expect(driver.schedule).not.toHaveBeenCalled();
  });

  it.each([1, 2_147_483_647])(
    "accepts bounded delay %s and leaves the timer referenced",
    async (delayMs) => {
      const driver = new FakeTimerDriver();
      const waiting = new NodeLeaseAuthorityScheduler(driver).wait(
        delayMs,
        new AbortController().signal,
      );

      expect(driver.timers[0]?.delayMs).toBe(delayMs);
      expect(driver.timers[0]?.handle.unref).not.toHaveBeenCalled();
      driver.fire();
      await expect(waiting).resolves.toBeUndefined();
    },
  );

  it.each([
    "checkpoint",
    Symbol("owner release"),
    Object.freeze({ reason: "object" }),
    new Error("abort cause"),
  ])("preserves an already-aborted reason by identity", async (reason) => {
    const driver = new FakeTimerDriver();
    const controller = new AbortController();
    controller.abort(reason);

    await expect(
      new NodeLeaseAuthorityScheduler(driver).wait(1, controller.signal),
    ).rejects.toBe(reason);
    expect(driver.schedule).not.toHaveBeenCalled();
    expect(driver.cancel).not.toHaveBeenCalled();
  });

  it("preserves the platform default abort reason by identity", async () => {
    const driver = new FakeTimerDriver();
    const controller = new AbortController();
    controller.abort();
    const reason = controller.signal.reason;

    await expect(
      new NodeLeaseAuthorityScheduler(driver).wait(1, controller.signal),
    ).rejects.toBe(reason);
    expect(reason).toBeInstanceOf(DOMException);
    expect(driver.schedule).not.toHaveBeenCalled();
  });

  it("handles abort reentrancy during listener registration", async () => {
    const driver = new FakeTimerDriver();
    const controller = new AbortController();
    const reason = Symbol("registration abort");
    const originalAdd = controller.signal.addEventListener.bind(
      controller.signal,
    );
    vi.spyOn(controller.signal, "addEventListener").mockImplementation(
      (...arguments_) => {
        originalAdd(...arguments_);
        controller.abort(reason);
      },
    );

    await expect(
      new NodeLeaseAuthorityScheduler(driver).wait(1, controller.signal),
    ).rejects.toBe(reason);
    expect(driver.schedule).not.toHaveBeenCalled();
  });

  it("cancels once and preserves abort identity before expiry", async () => {
    const driver = new FakeTimerDriver();
    const controller = new AbortController();
    const reason = Symbol("checkpoint");
    const waiting = new NodeLeaseAuthorityScheduler(driver).wait(
      10,
      controller.signal,
    );

    controller.abort(reason);
    driver.fire();
    await expect(waiting).rejects.toBe(reason);
    expect(driver.cancel).toHaveBeenCalledOnce();
    expect(driver.cancel).toHaveBeenCalledWith(driver.timers[0]?.handle);
  });

  it("lets expiry win and makes a later abort inert", async () => {
    const driver = new FakeTimerDriver();
    const controller = new AbortController();
    const waiting = new NodeLeaseAuthorityScheduler(driver).wait(
      10,
      controller.signal,
    );

    driver.fire();
    controller.abort(Symbol("late"));
    await expect(waiting).resolves.toBeUndefined();
    expect(driver.cancel).not.toHaveBeenCalled();
  });

  it("removes the abort listener on both expiry and abort", async () => {
    const driver = new FakeTimerDriver();
    const expiryController = new AbortController();
    const expiryRemove = vi.spyOn(
      expiryController.signal,
      "removeEventListener",
    );
    const expiring = new NodeLeaseAuthorityScheduler(driver).wait(
      1,
      expiryController.signal,
    );
    driver.fire(0);
    await expiring;
    expect(expiryRemove).toHaveBeenCalledOnce();

    const abortController = new AbortController();
    const abortRemove = vi.spyOn(abortController.signal, "removeEventListener");
    const aborting = new NodeLeaseAuthorityScheduler(driver).wait(
      1,
      abortController.signal,
    );
    const reason = Symbol("abort");
    abortController.abort(reason);
    await expect(aborting).rejects.toBe(reason);
    expect(abortRemove).toHaveBeenCalledOnce();
  });

  it("settles once when a driver invokes the callback repeatedly", async () => {
    const driver = new FakeTimerDriver();
    const controller = new AbortController();
    const waiting = new NodeLeaseAuthorityScheduler(driver).wait(
      1,
      controller.signal,
    );

    driver.fire();
    driver.fire();
    controller.abort(Symbol("late"));
    await expect(waiting).resolves.toBeUndefined();
    expect(driver.cancel).not.toHaveBeenCalled();
  });

  it("supports independent waits and reuse after different settlements", async () => {
    const driver = new FakeTimerDriver();
    const scheduler = new NodeLeaseAuthorityScheduler(driver);
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = scheduler.wait(1, firstController.signal);
    const second = scheduler.wait(2, secondController.signal);
    const reason = Symbol("first abort");

    firstController.abort(reason);
    driver.fire(1);
    await expect(first).rejects.toBe(reason);
    await expect(second).resolves.toBeUndefined();

    const third = scheduler.wait(3, new AbortController().signal);
    driver.fire(2);
    await expect(third).resolves.toBeUndefined();
    expect(driver.schedule).toHaveBeenCalledTimes(3);
  });

  it("redacts scheduling failure and retains the cause", async () => {
    const cause = new Error("private scheduling details");
    const driver: NodeTimerDriver = {
      schedule: vi.fn(() => {
        throw cause;
      }),
      cancel: vi.fn(),
    };

    await expect(
      new NodeLeaseAuthorityScheduler(driver).wait(
        1,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: "schedule_failed",
      cause,
      message: "Node timer scheduling failed.",
    });
  });

  it("does not let cancellation failure replace the abort reason", async () => {
    const reason = Object.freeze({ state: "stop" });
    const controller = new AbortController();
    const callback = vi.fn();
    const driver: NodeTimerDriver = {
      schedule: vi.fn((candidate) => {
        callback.mockImplementation(candidate);
        return Object.freeze({ id: 1 });
      }),
      cancel: vi.fn(() => {
        throw new Error("cancel failed");
      }),
    };
    const waiting = new NodeLeaseAuthorityScheduler(driver).wait(
      1,
      controller.signal,
    );

    controller.abort(reason);
    callback();
    await expect(waiting).rejects.toBe(reason);
    expect(driver.cancel).toHaveBeenCalledOnce();
  });

  it("honors synchronous expiry even when schedule subsequently throws", async () => {
    const driver: NodeTimerDriver = {
      schedule: vi.fn((callback) => {
        callback();
        throw new Error("late schedule throw");
      }),
      cancel: vi.fn(),
    };

    await expect(
      new NodeLeaseAuthorityScheduler(driver).wait(
        1,
        new AbortController().signal,
      ),
    ).resolves.toBeUndefined();
  });

  it("honors synchronous abort and releases the returned timer handle", async () => {
    const controller = new AbortController();
    const reason = Symbol("synchronous abort");
    const handle = Object.freeze({ id: 1 });
    const driver: NodeTimerDriver = {
      schedule: vi.fn(() => {
        controller.abort(reason);
        return handle;
      }),
      cancel: vi.fn(),
    };

    await expect(
      new NodeLeaseAuthorityScheduler(driver).wait(1, controller.signal),
    ).rejects.toBe(reason);
    expect(driver.cancel).toHaveBeenCalledWith(handle);
  });

  it("preserves monitor checkpoint and owner-release sentinel semantics", async () => {
    const driver = new FakeTimerDriver();
    const scheduler = new NodeLeaseAuthorityScheduler(driver);
    const supervise = vi.fn(async () => ({
      state: "renewed" as const,
      leaseExpiresAt: "2026-08-02T12:00:00.000Z",
    }));
    const revoke = vi.fn(async () => ({ state: "absent" as const }));
    const execution = runnerExecutionV1Schema.parse({
      version: "1",
      lease: {
        version: "1",
        runnerId: "10000000-0000-4000-8000-000000000001",
        taskId: taskFixture.taskId,
        attemptId: "20000000-0000-4000-8000-000000000002",
        fence: 3,
        leasedUntil: "2026-08-02T12:00:00.000Z",
      },
      task: taskFixture,
    });
    const monitor = new LeaseAuthorityMonitor({
      execution,
      supervisor: { leaseDurationMs: 30_000, supervise },
      scheduler,
      target: { revoke },
      heartbeatIntervalMs: 10_000,
      revocationGracePeriodMs: 0,
    });

    const running = monitor.start();
    await vi.waitFor(() => expect(driver.timers).toHaveLength(1));
    await expect(monitor.checkpoint()).resolves.toMatchObject({
      state: "renewed",
    });
    await vi.waitFor(() => expect(driver.timers).toHaveLength(2));
    await expect(monitor.stop()).resolves.toEqual({ state: "stopped" });
    await expect(running).resolves.toEqual({ state: "stopped" });
    expect(revoke).not.toHaveBeenCalled();
  });
});
