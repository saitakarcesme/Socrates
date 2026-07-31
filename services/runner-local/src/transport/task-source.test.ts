import { randomUUID } from "node:crypto";

import type { RunnerTaskDeliveryV1 } from "@socrates/contracts";
import { describe, expect, it, vi } from "vitest";

import { JournaledTaskSource } from "./task-source";

const delivery: RunnerTaskDeliveryV1 = {
  version: "1",
  deliveryId: randomUUID(),
  taskId: randomUUID(),
};

describe("journaled task source", () => {
  it("returns null without touching the journal when no work is available", async () => {
    const admit = vi.fn();
    const source = new JournaledTaskSource({
      client: { acquireTaskDelivery: async () => null },
      journal: { admit },
    });
    await expect(source.acquire()).resolves.toBeNull();
    expect(admit).not.toHaveBeenCalled();
  });

  it("does not hand off an offer until journal admission resolves", async () => {
    let release!: () => void;
    const admission = new Promise<void>((resolve) => {
      release = resolve;
    });
    const state = Object.freeze({
      deliveryId: delivery.deliveryId,
      taskId: delivery.taskId,
      attemptId: randomUUID(),
      state: "pending_claim" as const,
      admittedAt: "2026-07-31T12:00:00.000Z",
    });
    const source = new JournaledTaskSource({
      client: { acquireTaskDelivery: async () => delivery },
      journal: {
        admit: async () => {
          await admission;
          return state;
        },
      },
    });
    const acquired = source.acquire();
    let settled = false;
    void acquired.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await expect(acquired).resolves.toBe(state);
  });
});
