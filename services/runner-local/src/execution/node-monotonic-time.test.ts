import { describe, expect, it, vi } from "vitest";

import { nodeMonotonicTimeSource } from "./node-monotonic-time";
import { DurableExecutionTimingBarrier } from "./timing-barrier";

describe("nodeMonotonicTimeSource", () => {
  it("does not read monotonic time during module evaluation", async () => {
    vi.resetModules();
    const performanceModule = await import("node:perf_hooks");
    const read = vi.spyOn(performanceModule.performance, "now");

    await import("./node-monotonic-time");
    expect(read).not.toHaveBeenCalled();
    read.mockRestore();
  });

  it("is a frozen reusable singleton with finite monotonic readings", () => {
    expect(Object.isFrozen(nodeMonotonicTimeSource)).toBe(true);
    const first = nodeMonotonicTimeSource.now();
    const second = nodeMonotonicTimeSource.now();
    expect(Number.isFinite(first)).toBe(true);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThanOrEqual(first);
  });

  it("does not consult the wall clock", () => {
    const wallClock = vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("wall clock unavailable");
    });

    expect(() => nodeMonotonicTimeSource.now()).not.toThrow();
    expect(wallClock).not.toHaveBeenCalled();
    wallClock.mockRestore();
  });

  it("integrates with the durable execution timing barrier", async () => {
    const durableStart = vi.fn(async () => undefined);
    const barrier = new DurableExecutionTimingBarrier({
      barrier: { cross: durableStart },
      time: nodeMonotonicTimeSource,
    });

    expect(barrier.snapshot()).toEqual({ state: "not_started" });
    await barrier.cross();
    const timing = barrier.snapshot();
    expect(durableStart).toHaveBeenCalledOnce();
    expect(timing.state).toBe("started");
    if (timing.state === "started") {
      expect(Number.isSafeInteger(timing.elapsedMs)).toBe(true);
      expect(timing.elapsedMs).toBeGreaterThanOrEqual(0);
    }
  });
});
