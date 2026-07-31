import { readFile } from "node:fs/promises";

import {
  experimentTaskV2Schema,
  runnerExecutionV1Schema,
} from "@socrates/contracts";
import { beforeAll, describe, expect, it } from "vitest";

import type { RunnerExecutionV1 } from "@socrates/contracts";
import { DeterministicFakeRunner } from "./deterministic-fake-runner";

const runnerId = "019c1170-8b7a-7a60-b7f8-f35c85d73750";
const attemptId = "019c1170-8b7a-7a60-b7f8-f35c85d73751";
let execution: RunnerExecutionV1;

beforeAll(async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL(
        "../../../../packages/contracts/fixtures/runner/task-v2.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const task = experimentTaskV2Schema.parse(fixture);
  execution = runnerExecutionV1Schema.parse({
    version: "1",
    lease: {
      version: "1",
      runnerId,
      taskId: task.taskId,
      attemptId,
      fence: 1,
      leasedUntil: "2026-07-31T00:05:00.000Z",
    },
    task,
  });
});

describe("DeterministicFakeRunner", () => {
  it("reproduces one complete ordered lifecycle without executing work", async () => {
    const first = new DeterministicFakeRunner({
      measurementAmount: "2.1",
    });
    const restarted = new DeterministicFakeRunner({
      measurementAmount: "2.1",
    });

    const firstEvents = await Array.fromAsync(first.execute(execution));
    const replayedEvents = await Array.fromAsync(restarted.execute(execution));

    expect(firstEvents.map(({ type }) => type)).toEqual([
      "workspace.prepared",
      "action.started",
      "action.completed",
      "measurement.recorded",
      "task.succeeded",
    ]);
    expect(replayedEvents).toEqual(firstEvents);
    expect(firstEvents.map(({ sequence }) => sequence)).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  it("emits one fenced cancellation at the next sequence", async () => {
    const runner = new DeterministicFakeRunner({ measurementAmount: "2.1" });
    const iterator = runner.execute(execution)[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "workspace.prepared", sequence: 1 },
      done: false,
    });
    await runner.cancel({
      version: "1",
      runnerId,
      taskId: execution.task.taskId,
      attemptId,
      fence: 1,
      requestedAt: "2026-07-31T00:00:01.000Z",
      gracePeriodMs: 100,
      reason: "operator",
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "task.cancelled", sequence: 2 },
      done: false,
    });
    await expect(iterator.next()).resolves.toEqual({
      value: undefined,
      done: true,
    });
  });
});
