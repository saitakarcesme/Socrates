import {
  runnerCancellationV1Schema,
  runnerExecutionV1Schema,
  type RunnerExecutionV1,
} from "@socrates/contracts";
import { describe, expect, it, vi } from "vitest";

import type { LeaseSupervisionResult } from "./lease-supervisor";
import {
  LeaseAuthorityMonitor,
  LeaseAuthorityMonitorError,
  type LeaseAuthorityScheduler,
  type LeaseAuthoritySupervisor,
} from "./lease-authority-monitor";
import taskFixture from "../../../../packages/contracts/fixtures/runner/task-v2.json";

const execution = runnerExecutionV1Schema.parse({
  version: "1",
  lease: {
    version: "1",
    runnerId: "10000000-0000-4000-8000-000000000001",
    taskId: taskFixture.taskId,
    attemptId: "20000000-0000-4000-8000-000000000002",
    fence: 3,
    leasedUntil: "1970-01-01T00:00:00.001Z",
  },
  task: taskFixture,
});

const cancellation = runnerCancellationV1Schema.parse({
  version: "1",
  runnerId: execution.lease.runnerId,
  taskId: execution.lease.taskId,
  attemptId: execution.lease.attemptId,
  fence: execution.lease.fence,
  requestedAt: "2026-07-31T20:00:00.000Z",
  gracePeriodMs: 100,
  reason: "operator",
});
const termination = Object.freeze({
  state: "terminated" as const,
  forced: true,
});

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve(value: T): void;
  reject(cause: unknown): void;
}>;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class ManualScheduler implements LeaseAuthorityScheduler {
  readonly waits: Array<{
    delayMs: number;
    signal: AbortSignal;
    operation: Deferred<void>;
  }> = [];

  wait(delayMs: number, signal: AbortSignal): Promise<void> {
    const operation = deferred<void>();
    signal.addEventListener(
      "abort",
      () => operation.reject(new DOMException("Stopped", "AbortError")),
      { once: true },
    );
    this.waits.push({ delayMs, signal, operation });
    return operation.promise;
  }
}

function fixture(options: {
  steps?: readonly (
    LeaseSupervisionResult | Error | Deferred<LeaseSupervisionResult>
  )[];
  scheduler?: LeaseAuthorityScheduler;
  leaseDurationMs?: number;
  heartbeatIntervalMs?: number;
  revocationGracePeriodMs?: number;
  revoke?: ReturnType<typeof vi.fn>;
  candidate?: RunnerExecutionV1;
}) {
  const steps = [...(options.steps ?? [{ state: "stale" }])];
  const supervise = vi.fn(async () => {
    const step = steps.shift();
    if (!step) throw new Error("Unexpected supervision step.");
    if (step instanceof Error) throw step;
    if ("promise" in step) return step.promise;
    return step;
  });
  const supervisor: LeaseAuthoritySupervisor = {
    leaseDurationMs: options.leaseDurationMs ?? 30_000,
    supervise,
  };
  const revoke = options.revoke ?? vi.fn(async () => termination);
  const scheduler = options.scheduler ?? new ManualScheduler();
  return {
    monitor: new LeaseAuthorityMonitor({
      execution: options.candidate ?? execution,
      supervisor,
      scheduler,
      target: { revoke },
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? 10_000,
      revocationGracePeriodMs: options.revocationGracePeriodMs ?? 0,
    }),
    revoke,
    scheduler,
    supervise,
  };
}

describe("LeaseAuthorityMonitor", () => {
  it.each([
    { leaseDurationMs: 0 },
    { leaseDurationMs: Number.MAX_SAFE_INTEGER + 1 },
    { heartbeatIntervalMs: 0 },
    { heartbeatIntervalMs: 1.5 },
    { heartbeatIntervalMs: 10_001 },
    { revocationGracePeriodMs: -1 },
    { revocationGracePeriodMs: 60_001 },
  ])("rejects invalid bounded configuration %#", (overrides) => {
    expect(() => fixture(overrides)).toThrow(RangeError);
  });

  it("heartbeats immediately, then waits without overlapping calls", async () => {
    const first = deferred<LeaseSupervisionResult>();
    const scheduler = new ManualScheduler();
    const value = fixture({
      steps: [
        first,
        { state: "renewed", leaseExpiresAt: "ignored" },
        { state: "stale" },
      ],
      scheduler,
    });

    const running = value.monitor.start();
    expect(value.supervise).toHaveBeenCalledTimes(1);
    expect(scheduler.waits).toHaveLength(0);
    first.resolve({ state: "renewed", leaseExpiresAt: "also-ignored" });
    await vi.waitFor(() => expect(scheduler.waits).toHaveLength(1));
    expect(scheduler.waits[0]?.delayMs).toBe(10_000);
    expect(value.supervise).toHaveBeenCalledTimes(1);
    scheduler.waits[0]!.operation.resolve();
    await vi.waitFor(() => expect(value.supervise).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(scheduler.waits).toHaveLength(2));
    scheduler.waits[1]!.operation.resolve();
    await expect(running).resolves.toEqual({ state: "stale" });
    expect(value.revoke).toHaveBeenCalledWith({
      reason: "lease_stale",
      gracePeriodMs: 0,
    });
  });

  it("returns authenticated cancellation without local revocation", async () => {
    const value = fixture({
      steps: [
        {
          state: "cancelled",
          leaseExpiresAt: "ignored",
          cancellation,
          termination,
        },
      ],
    });

    const result = await value.monitor.start();
    expect(result).toEqual({ state: "cancelled", cancellation, termination });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.cancellation)).toBe(true);
    expect(result.termination).toBe(termination);
    expect(value.revoke).not.toHaveBeenCalled();
  });

  it("stops a scheduled wait without revoking authority", async () => {
    const scheduler = new ManualScheduler();
    const value = fixture({
      steps: [{ state: "renewed", leaseExpiresAt: "ignored" }],
      scheduler,
    });

    const running = value.monitor.start();
    await vi.waitFor(() => expect(scheduler.waits).toHaveLength(1));
    await expect(value.monitor.stop()).resolves.toEqual({ state: "stopped" });
    await expect(running).resolves.toEqual({ state: "stopped" });
    expect(scheduler.waits[0]?.signal.aborted).toBe(true);
    expect(value.revoke).not.toHaveBeenCalled();
  });

  it("lets an in-flight heartbeat settle before honoring stop", async () => {
    const heartbeat = deferred<LeaseSupervisionResult>();
    const value = fixture({ steps: [heartbeat] });

    const running = value.monitor.start();
    const stopping = value.monitor.stop();
    let settled = false;
    void stopping.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    heartbeat.resolve({ state: "renewed", leaseExpiresAt: "ignored" });
    await expect(stopping).resolves.toEqual({ state: "stopped" });
    expect(stopping).toBe(running);
  });

  it("preserves cancellation or stale outcomes that race owner stop", async () => {
    const cancelled = deferred<LeaseSupervisionResult>();
    const cancelValue = fixture({ steps: [cancelled] });
    cancelValue.monitor.start();
    const cancelStop = cancelValue.monitor.stop();
    cancelled.resolve({
      state: "cancelled",
      leaseExpiresAt: "ignored",
      cancellation,
      termination,
    });
    await expect(cancelStop).resolves.toMatchObject({ state: "cancelled" });

    const stale = deferred<LeaseSupervisionResult>();
    const staleValue = fixture({ steps: [stale] });
    staleValue.monitor.start();
    const staleStop = staleValue.monitor.stop();
    stale.resolve({ state: "stale" });
    await expect(staleStop).resolves.toEqual({ state: "stale" });
    expect(staleValue.revoke).toHaveBeenCalledOnce();
  });

  it("revokes and classifies heartbeat uncertainty without leaking its text", async () => {
    const failure = new Error("secret=/host/private/token");
    const value = fixture({ steps: [failure], revocationGracePeriodMs: 250 });

    const result = value.monitor.start();
    await expect(result).rejects.toMatchObject({
      code: "authority_uncertain",
      message: "Lease authority became uncertain.",
      cause: failure,
    });
    expect(value.revoke).toHaveBeenCalledWith({
      reason: "lease_uncertain",
      gracePeriodMs: 250,
    });
    await expect(result).rejects.not.toThrow("secret=/host/private/token");
  });

  it("revokes and classifies scheduler failure", async () => {
    const failure = new Error("timer failed");
    const value = fixture({
      steps: [{ state: "renewed", leaseExpiresAt: "ignored" }],
      scheduler: { wait: vi.fn(async () => Promise.reject(failure)) },
    });

    await expect(value.monitor.start()).rejects.toMatchObject({
      code: "scheduler_failed",
      cause: failure,
    });
    expect(value.revoke).toHaveBeenCalledWith({
      reason: "scheduler_failure",
      gracePeriodMs: 0,
    });
  });

  it("retains both primary and revocation uncertainty in memory", async () => {
    const heartbeatFailure = new Error("heartbeat failed");
    const revocationFailure = new Error("sandbox stop failed");
    const value = fixture({
      steps: [heartbeatFailure],
      revoke: vi.fn(async () => Promise.reject(revocationFailure)),
    });

    const result = value.monitor.start();
    await expect(result).rejects.toMatchObject({ code: "revocation_failed" });
    const error = await result.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(LeaseAuthorityMonitorError);
    expect(error.cause).toBeInstanceOf(AggregateError);
    expect((error.cause as AggregateError).errors).toEqual([
      heartbeatFailure,
      revocationFailure,
    ]);
  });

  it("seals an owner-stopped monitor before any heartbeat", async () => {
    const value = fixture({});
    const stopped = value.monitor.stop();

    await expect(stopped).resolves.toEqual({ state: "stopped" });
    expect(value.monitor.start()).toBe(stopped);
    expect(value.supervise).not.toHaveBeenCalled();
    expect(value.revoke).not.toHaveBeenCalled();
  });
});
