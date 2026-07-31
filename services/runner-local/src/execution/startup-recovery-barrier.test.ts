import { describe, expect, it, vi } from "vitest";

import {
  RunnerStartupRecoveryBarrier,
  RunnerStartupRecoveryError,
} from "./startup-recovery-barrier";

function harness(sandboxCount = 2, sourceCount = 3) {
  const order: string[] = [];
  const sandboxes = {
    recoverOwned: vi.fn(async () => {
      order.push("sandboxes");
      return sandboxCount;
    }),
  };
  const sources = {
    recoverOwned: vi.fn(async () => {
      order.push("sources");
      return sourceCount;
    }),
  };
  return {
    barrier: new RunnerStartupRecoveryBarrier({ sandboxes, sources }),
    order,
    sandboxes,
    sources,
  };
}

describe("RunnerStartupRecoveryBarrier", () => {
  it("removes sandboxes before sources and returns immutable exact counts", async () => {
    const value = harness(7, 11);

    const result = await value.barrier.recover();

    expect(value.order).toEqual(["sandboxes", "sources"]);
    expect(result).toEqual({ sandboxesRemoved: 7, sourcesRemoved: 11 });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("shares one in-flight and completed recovery promise", async () => {
    const value = harness();
    const first = value.barrier.recover();
    const second = value.barrier.recover();

    expect(second).toBe(first);
    await expect(first).resolves.toBe(await second);
    expect(value.sandboxes.recoverOwned).toHaveBeenCalledOnce();
    expect(value.sources.recoverOwned).toHaveBeenCalledOnce();
    expect(value.barrier.recover()).toBe(first);
  });

  it("keeps source recovery closed after sandbox failure", async () => {
    const value = harness();
    const failure = new Error("engine unavailable");
    value.sandboxes.recoverOwned.mockRejectedValueOnce(failure);

    const first = value.barrier.recover();
    await expect(first).rejects.toEqual(
      expect.objectContaining({
        code: "sandbox_recovery_failed",
        cause: failure,
      }),
    );
    expect(value.sources.recoverOwned).not.toHaveBeenCalled();
    expect(value.barrier.recover()).toBe(first);
    await expect(value.barrier.recover()).rejects.toMatchObject({
      code: "sandbox_recovery_failed",
    });
    expect(value.sandboxes.recoverOwned).toHaveBeenCalledOnce();
  });

  it("retains source failure after successful sandbox recovery", async () => {
    const value = harness();
    const failure = new Error("filesystem unavailable");
    value.sources.recoverOwned.mockRejectedValueOnce(failure);

    const first = value.barrier.recover();
    await expect(first).rejects.toEqual(
      expect.objectContaining({
        code: "source_recovery_failed",
        cause: failure,
      }),
    );
    await expect(value.barrier.recover()).rejects.toMatchObject({
      code: "source_recovery_failed",
    });
    expect(value.sandboxes.recoverOwned).toHaveBeenCalledOnce();
    expect(value.sources.recoverOwned).toHaveBeenCalledOnce();
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    "rejects invalid sandbox count %s before source recovery",
    async (count) => {
      const value = harness(count);

      await expect(value.barrier.recover()).rejects.toBeInstanceOf(
        RunnerStartupRecoveryError,
      );
      await expect(value.barrier.recover()).rejects.toMatchObject({
        code: "invalid_result",
      });
      expect(value.sources.recoverOwned).not.toHaveBeenCalled();
    },
  );

  it.each([-1, 0.5, Number.NaN, Number.NEGATIVE_INFINITY, 2 ** 53])(
    "rejects invalid source count %s after sandbox recovery",
    async (count) => {
      const value = harness(0, count);

      await expect(value.barrier.recover()).rejects.toMatchObject({
        code: "invalid_result",
      });
      expect(value.order).toEqual(["sandboxes", "sources"]);
      expect(value.sandboxes.recoverOwned).toHaveBeenCalledOnce();
      expect(value.sources.recoverOwned).toHaveBeenCalledOnce();
    },
  );
});
