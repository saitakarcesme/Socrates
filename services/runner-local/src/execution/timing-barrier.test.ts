import { describe, expect, it, vi } from "vitest";

import {
  DurableExecutionTimingBarrier,
  DurableExecutionTimingBarrierError,
  type MonotonicTimeSource,
} from "./timing-barrier";

function time(...readings: number[]): MonotonicTimeSource {
  return {
    now: vi.fn(() => {
      const value = readings.shift();
      if (value === undefined) throw new Error("No monotonic reading.");
      return value;
    }),
  };
}

describe("DurableExecutionTimingBarrier", () => {
  it("reports not started without touching the time source", () => {
    const source = time(10);
    const barrier = new DurableExecutionTimingBarrier({
      barrier: { cross: vi.fn(async () => undefined) },
      time: source,
    });

    const timing = barrier.snapshot();
    expect(timing).toEqual({ state: "not_started" });
    expect(Object.isFrozen(timing)).toBe(true);
    expect(source.now).not.toHaveBeenCalled();
  });

  it("records after durable start and rounds elapsed time upward", async () => {
    const order: string[] = [];
    const source: MonotonicTimeSource = {
      now: vi
        .fn()
        .mockImplementationOnce(() => {
          order.push("baseline");
          return 10.25;
        })
        .mockImplementationOnce(() => 12.251),
    };
    const barrier = new DurableExecutionTimingBarrier({
      barrier: {
        cross: vi.fn(async () => {
          order.push("durable");
        }),
      },
      time: source,
    });

    await barrier.cross();
    expect(order).toEqual(["durable", "baseline"]);
    expect(barrier.snapshot()).toEqual({ state: "started", elapsedMs: 3 });
  });

  it("shares one exact crossing operation", async () => {
    const underlying = vi.fn(async () => undefined);
    const source = time(1, 2);
    const barrier = new DurableExecutionTimingBarrier({
      barrier: { cross: underlying },
      time: source,
    });

    const left = barrier.cross();
    const right = barrier.cross();
    expect(right).toBe(left);
    await left;
    expect(underlying).toHaveBeenCalledOnce();
    expect(barrier.snapshot()).toEqual({ state: "started", elapsedMs: 1 });
  });

  it("closes durable-start rejection without reading time", async () => {
    const cause = new Error("journal uncertain");
    const source = time(1);
    const barrier = new DurableExecutionTimingBarrier({
      barrier: { cross: vi.fn(async () => Promise.reject(cause)) },
      time: source,
    });

    await expect(barrier.cross()).rejects.toMatchObject({
      code: "start_uncertain",
      cause,
    });
    expect(source.now).not.toHaveBeenCalled();
    expect(barrier.snapshot()).toEqual({ state: "not_started" });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
    "rejects invalid baseline %s as timing uncertainty",
    async (reading) => {
      const barrier = new DurableExecutionTimingBarrier({
        barrier: { cross: vi.fn(async () => undefined) },
        time: time(reading),
      });

      await expect(barrier.cross()).rejects.toMatchObject({
        code: "timing_uncertain",
      });
    },
  );

  it.each([
    [10, 9],
    [0, Number.MAX_SAFE_INTEGER + 1],
    [0, Number.NaN],
  ])("rejects invalid elapsed readings %s -> %s", async (start, end) => {
    const barrier = new DurableExecutionTimingBarrier({
      barrier: { cross: vi.fn(async () => undefined) },
      time: time(start, end),
    });
    await barrier.cross();

    expect(() => barrier.snapshot()).toThrowError(
      DurableExecutionTimingBarrierError,
    );
    try {
      barrier.snapshot();
    } catch (error) {
      expect(error).toMatchObject({ code: "timing_uncertain" });
    }
  });

  it("redacts time-source failure behind a typed error", async () => {
    const cause = new Error("clock implementation secret");
    const barrier = new DurableExecutionTimingBarrier({
      barrier: { cross: vi.fn(async () => undefined) },
      time: {
        now: vi.fn(() => {
          throw cause;
        }),
      },
    });

    await expect(barrier.cross()).rejects.toMatchObject({
      code: "timing_uncertain",
      cause,
      message: "Monotonic execution time is unavailable.",
    });
  });
});
