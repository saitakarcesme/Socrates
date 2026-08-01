import { runnerExecutionV1Schema } from "@socrates/contracts";
import { describe, expect, it, vi } from "vitest";

import { attemptKeyFor } from "../spool/codec";
import type { SpoolState } from "../spool/contracts";
import type { WorkJournalState } from "./contracts";
import { TerminalPublicationDispositionAuditor } from "./terminal-publication-disposition";
import taskFixture from "../../../../packages/contracts/fixtures/runner/task-v2.json";

const deliveryId = "40000000-0000-4000-8000-000000000004";
const execution = runnerExecutionV1Schema.parse({
  version: "1",
  lease: {
    version: "1",
    runnerId: "10000000-0000-4000-8000-000000000001",
    taskId: taskFixture.taskId,
    attemptId: "20000000-0000-4000-8000-000000000002",
    fence: 4,
    leasedUntil: "2026-08-01T02:00:00.000Z",
  },
  task: taskFixture,
});
const attemptKey = attemptKeyFor(execution);

function work(
  state: WorkJournalState["state"] = "execution_started",
): WorkJournalState {
  return {
    deliveryId,
    taskId: execution.lease.taskId,
    attemptId: execution.lease.attemptId,
    state,
    admittedAt: "2026-08-01T00:00:00.000Z",
    claimedAt: "2026-08-01T00:00:01.000Z",
    ...(state === "execution_started"
      ? { executionStartedAt: "2026-08-01T00:00:02.000Z" }
      : {}),
    ...(state === "completed"
      ? {
          completedAt: "2026-08-01T00:00:03.000Z",
          completion: { attemptKey, acknowledgedSequence: 2 },
        }
      : {}),
  };
}

function spool(overrides: Partial<SpoolState> = {}): SpoolState {
  return {
    attemptKey,
    acknowledgedSequence: 0,
    lastSequence: 2,
    pendingEvents: 2,
    terminal: true,
    ...overrides,
  };
}

function fixture(options?: {
  work?: WorkJournalState | null;
  claimed?: typeof execution | null;
  spool?: SpoolState | null;
}) {
  const selectedWork = options && "work" in options ? options.work : work();
  const selectedClaim =
    options && "claimed" in options ? options.claimed : execution;
  const selectedSpool = options && "spool" in options ? options.spool : null;
  const inspect = vi.fn(async () => selectedWork);
  const claimedExecution = vi.fn(async () => selectedClaim);
  const inspectExisting = vi.fn(async () => selectedSpool);
  const value = new TerminalPublicationDispositionAuditor(
    { inspect, claimedExecution },
    { inspectExisting },
  );
  return { claimedExecution, inspect, inspectExisting, value };
}

describe("TerminalPublicationDispositionAuditor", () => {
  it("rejects invalid input before durable reads", async () => {
    const value = fixture();

    await expect(value.value.audit("invalid", execution)).rejects.toMatchObject(
      {
        code: "invalid_input",
      },
    );
    expect(value.inspect).not.toHaveBeenCalled();
    expect(value.inspectExisting).not.toHaveBeenCalled();
  });

  it.each([
    ["missing spool", null],
    [
      "empty spool",
      spool({
        acknowledgedSequence: 0,
        lastSequence: 0,
        pendingEvents: 0,
        terminal: false,
      }),
    ],
  ])("reports absent for active work with %s", async (_, state) => {
    const value = fixture({ spool: state });

    const result = await value.value.audit(deliveryId, execution);
    expect(result).toEqual({ state: "absent", work: work() });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.work)).toBe(true);
  });

  it("reports exact pending counters", async () => {
    const value = fixture({
      spool: spool({ acknowledgedSequence: 1, pendingEvents: 1 }),
    });

    await expect(value.value.audit(deliveryId, execution)).resolves.toEqual({
      state: "pending",
      work: work(),
      acknowledgedSequence: 1,
      lastSequence: 2,
      pendingEvents: 1,
    });
  });

  it("reports a fully acknowledged active batch", async () => {
    const value = fixture({
      spool: spool({ acknowledgedSequence: 2, pendingEvents: 0 }),
    });

    await expect(value.value.audit(deliveryId, execution)).resolves.toEqual({
      state: "acknowledged",
      work: work(),
      acknowledgedSequence: 2,
      lastSequence: 2,
      pendingEvents: 0,
    });
  });

  it("requires matching work completion and terminal acknowledgement", async () => {
    const completed = work("completed");
    const value = fixture({
      work: completed,
      spool: spool({ acknowledgedSequence: 2, pendingEvents: 0 }),
    });

    const result = await value.value.audit(deliveryId, execution);
    expect(result).toEqual({
      state: "completed",
      work: completed,
      acknowledgedSequence: 2,
      lastSequence: 2,
      pendingEvents: 0,
    });
    expect(Object.isFrozen(result.work.completion)).toBe(true);
  });

  it.each([
    ["missing work", null, execution, "state_uncertain"],
    ["retired work", work("retired"), execution, "state_uncertain"],
    [
      "work identity drift",
      { ...work(), attemptId: "90000000-0000-4000-8000-000000000009" },
      execution,
      "identity_conflict",
    ],
    ["missing claim", work(), null, "identity_conflict"],
    [
      "claim digest drift",
      work(),
      runnerExecutionV1Schema.parse({
        ...execution,
        lease: { ...execution.lease, fence: execution.lease.fence + 1 },
      }),
      "identity_conflict",
    ],
  ])("rejects %s", async (_, state, claimed, code) => {
    const value = fixture({ work: state, claimed });

    await expect(
      value.value.audit(deliveryId, execution),
    ).rejects.toMatchObject({
      code,
    });
    expect(value.inspectExisting).not.toHaveBeenCalled();
  });

  it.each([
    ["attempt key", spool({ attemptKey: "f".repeat(64) })],
    ["negative acknowledgement", spool({ acknowledgedSequence: -1 })],
    ["fractional last sequence", spool({ lastSequence: 1.5 })],
    ["counter equation", spool({ pendingEvents: 1 })],
    [
      "acknowledgement ahead",
      spool({ acknowledgedSequence: 3, pendingEvents: 0 }),
    ],
    ["non-terminal evidence", spool({ terminal: false })],
  ])("rejects invalid spool %s", async (_, state) => {
    const value = fixture({ spool: state });
    await expect(
      value.value.audit(deliveryId, execution),
    ).rejects.toMatchObject({
      code: "state_uncertain",
    });
  });

  it.each([
    ["missing spool", null],
    [
      "empty spool",
      spool({
        acknowledgedSequence: 0,
        lastSequence: 0,
        pendingEvents: 0,
        terminal: false,
      }),
    ],
    ["pending spool", spool()],
    [
      "completion sequence drift",
      spool({ acknowledgedSequence: 3, lastSequence: 3, pendingEvents: 0 }),
    ],
  ])("rejects completed work with %s", async (_, state) => {
    const value = fixture({ work: work("completed"), spool: state });
    await expect(
      value.value.audit(deliveryId, execution),
    ).rejects.toMatchObject({
      code: "state_uncertain",
    });
  });

  it("copies and freezes mutable durable outputs", async () => {
    const mutable = work();
    const value = fixture({
      work: mutable,
      spool: spool({ acknowledgedSequence: 2, pendingEvents: 0 }),
    });
    const result = await value.value.audit(deliveryId, execution);
    Object.assign(mutable, { state: "retired" });

    expect(result.work.state).toBe("execution_started");
    expect(() => Object.assign(result, { state: "absent" })).toThrow();
    expect(() => Object.assign(result.work, { state: "retired" })).toThrow();
  });
});
