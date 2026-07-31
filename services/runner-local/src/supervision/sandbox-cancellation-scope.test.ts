import {
  runnerCancellationV1Schema,
  runnerExecutionV1Schema,
  type RunnerCancellationV1,
} from "@socrates/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  SandboxCancellationScope,
  SandboxCancellationScopeError,
} from "./sandbox-cancellation-scope";
import taskFixture from "../../../../packages/contracts/fixtures/runner/task-v2.json";

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

function command(
  overrides: Partial<RunnerCancellationV1> = {},
): RunnerCancellationV1 {
  return runnerCancellationV1Schema.parse({
    version: "1",
    runnerId: execution.lease.runnerId,
    taskId: execution.lease.taskId,
    attemptId: execution.lease.attemptId,
    fence: execution.lease.fence,
    requestedAt: "2026-07-31T17:59:00.000Z",
    gracePeriodMs: 2_500,
    reason: "operator",
    ...overrides,
  });
}

describe("SandboxCancellationScope", () => {
  it("rejects invalid execution and command shapes before side effects", async () => {
    expect(
      () =>
        new SandboxCancellationScope(
          {
            ...execution,
            lease: { ...execution.lease, fence: 0 },
          },
          { cancel: vi.fn(async () => true) },
        ),
    ).toThrow();

    const cancel = vi.fn(async () => true);
    const scope = new SandboxCancellationScope(execution, { cancel });
    await expect(
      scope.cancel({ ...command(), gracePeriodMs: 60_001 }),
    ).rejects.toThrow();
    expect(scope.signal.aborted).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("aborts before forwarding exact identity and grace to the backend", async () => {
    const observed: { scope?: SandboxCancellationScope } = {};
    const cancel = vi.fn(async () => {
      expect(observed.scope?.signal.aborted).toBe(true);
      return true;
    });
    const scope = new SandboxCancellationScope(execution, { cancel });
    observed.scope = scope;

    await expect(scope.cancel(command())).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledWith(
      {
        runnerId: execution.lease.runnerId,
        taskId: execution.lease.taskId,
        attemptId: execution.lease.attemptId,
        fence: execution.lease.fence,
      },
      2_500,
    );
  });

  it("accepts cancellation before an active sandbox exists", async () => {
    const cancel = vi.fn(async () => false);
    const scope = new SandboxCancellationScope(execution, { cancel });

    await expect(scope.cancel(command())).resolves.toBeUndefined();
    expect(scope.signal.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([
    ["runnerId", "30000000-0000-4000-8000-000000000003"],
    ["taskId", "30000000-0000-4000-8000-000000000003"],
    ["attemptId", "30000000-0000-4000-8000-000000000003"],
    ["fence", 4],
  ] as const)(
    "rejects %s drift before any side effect",
    async (field, value) => {
      const cancel = vi.fn(async () => true);
      const scope = new SandboxCancellationScope(execution, { cancel });

      await expect(
        scope.cancel(command({ [field]: value })),
      ).rejects.toMatchObject({
        code: "identity_mismatch",
      });
      expect(scope.signal.aborted).toBe(false);
      expect(cancel).not.toHaveBeenCalled();
    },
  );

  it("joins exact concurrent and sequential duplicate calls", async () => {
    let settle = () => undefined;
    const pending = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const cancel = vi.fn(async () => {
      await pending;
      return true;
    });
    const scope = new SandboxCancellationScope(execution, { cancel });
    const firstCommand = command();

    const first = scope.cancel(firstCommand);
    const concurrent = scope.cancel({ ...firstCommand });
    expect(concurrent).toBe(first);
    expect(cancel).toHaveBeenCalledOnce();
    settle();
    await first;
    expect(scope.cancel({ ...firstCommand })).toBe(first);
    await expect(scope.cancel({ ...firstCommand })).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects policy drift without replacing the first operation", async () => {
    const cancel = vi.fn(async () => true);
    const scope = new SandboxCancellationScope(execution, { cancel });
    await scope.cancel(command());

    for (const conflicting of [
      command({ requestedAt: "2026-07-31T17:59:01.000Z" }),
      command({ gracePeriodMs: 1 }),
      command({ reason: "budget" }),
    ]) {
      await expect(scope.cancel(conflicting)).rejects.toBeInstanceOf(
        SandboxCancellationScopeError,
      );
    }
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("replays backend uncertainty without retrying", async () => {
    const failure = new Error("engine unavailable");
    const cancel = vi.fn(() => {
      throw failure;
    });
    const scope = new SandboxCancellationScope(execution, { cancel });
    const cancellation = command();

    const first = scope.cancel(cancellation);
    await expect(first).rejects.toBe(failure);
    const replay = scope.cancel({ ...cancellation });
    expect(replay).toBe(first);
    await expect(replay).rejects.toBe(failure);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("validates local revocation before aborting or touching the backend", async () => {
    const cancel = vi.fn(async () => true);
    const scope = new SandboxCancellationScope(execution, { cancel });

    await expect(
      scope.revoke({ reason: "lease_stale", gracePeriodMs: 60_001 }),
    ).rejects.toThrow(RangeError);
    await expect(
      scope.revoke({
        reason: "unsupported" as "lease_stale",
        gracePeriodMs: 0,
      }),
    ).rejects.toThrow(RangeError);
    expect(scope.signal.aborted).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("aborts before applying exact local revocation grace", async () => {
    const observed: { scope?: SandboxCancellationScope } = {};
    const cancel = vi.fn(async () => {
      expect(observed.scope?.signal.aborted).toBe(true);
      return true;
    });
    const scope = new SandboxCancellationScope(execution, { cancel });
    observed.scope = scope;

    await expect(
      scope.revoke({ reason: "lease_uncertain", gracePeriodMs: 100 }),
    ).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledWith(
      {
        runnerId: execution.lease.runnerId,
        taskId: execution.lease.taskId,
        attemptId: execution.lease.attemptId,
        fence: execution.lease.fence,
      },
      100,
    );
  });

  it("joins exact local revocation and rejects policy drift", async () => {
    let settle = () => undefined;
    const pending = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const cancel = vi.fn(async () => {
      await pending;
      return true;
    });
    const scope = new SandboxCancellationScope(execution, { cancel });
    const revocation = {
      reason: "lease_stale" as const,
      gracePeriodMs: 0,
    };

    const first = scope.revoke(revocation);
    expect(scope.revoke({ ...revocation })).toBe(first);
    await expect(
      scope.revoke({ ...revocation, gracePeriodMs: 1 }),
    ).rejects.toMatchObject({ code: "policy_conflict" });
    settle();
    await first;
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("allows only the first authenticated or local termination policy", async () => {
    const cancellationFirst = new SandboxCancellationScope(execution, {
      cancel: vi.fn(async () => true),
    });
    await cancellationFirst.cancel(command());
    await expect(
      cancellationFirst.revoke({
        reason: "lease_uncertain",
        gracePeriodMs: 0,
      }),
    ).rejects.toMatchObject({ code: "policy_conflict" });

    const revocationFirst = new SandboxCancellationScope(execution, {
      cancel: vi.fn(async () => true),
    });
    await revocationFirst.revoke({
      reason: "scheduler_failure",
      gracePeriodMs: 0,
    });
    await expect(revocationFirst.cancel(command())).rejects.toMatchObject({
      code: "policy_conflict",
    });
  });
});
