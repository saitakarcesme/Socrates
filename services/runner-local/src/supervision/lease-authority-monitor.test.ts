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
    signal.addEventListener("abort", () => operation.reject(signal.reason), {
      once: true,
    });
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

  it("joins concurrent checkpoints to the initial in-flight heartbeat", async () => {
    const heartbeat = deferred<LeaseSupervisionResult>();
    const scheduler = new ManualScheduler();
    const value = fixture({ steps: [heartbeat], scheduler });

    const first = value.monitor.checkpoint();
    const duplicate = value.monitor.checkpoint();
    const running = value.monitor.start();
    expect(duplicate).toBe(first);
    expect(value.supervise).toHaveBeenCalledOnce();

    heartbeat.resolve({
      state: "renewed",
      leaseExpiresAt: "2026-08-01T20:00:30.000Z",
    });
    const observation = await first;
    await expect(duplicate).resolves.toBe(observation);
    expect(observation).toEqual({
      state: "renewed",
      leaseExpiresAt: "2026-08-01T20:00:30.000Z",
    });
    expect(Object.isFrozen(observation)).toBe(true);

    await vi.waitFor(() => expect(scheduler.waits).toHaveLength(1));
    await expect(value.monitor.stop()).resolves.toEqual({ state: "stopped" });
    await expect(running).resolves.toEqual({ state: "stopped" });
  });

  it("wakes a scheduled wait for one immediate checkpoint heartbeat", async () => {
    const scheduler = new ManualScheduler();
    const value = fixture({
      steps: [
        {
          state: "renewed",
          leaseExpiresAt: "2026-08-01T20:00:30.000Z",
        },
        {
          state: "renewed",
          leaseExpiresAt: "2026-08-01T20:01:00.000Z",
        },
      ],
      scheduler,
    });

    const running = value.monitor.start();
    await vi.waitFor(() => expect(scheduler.waits).toHaveLength(1));
    const observation = value.monitor.checkpoint();
    expect(scheduler.waits[0]?.signal.aborted).toBe(true);
    await expect(observation).resolves.toEqual({
      state: "renewed",
      leaseExpiresAt: "2026-08-01T20:01:00.000Z",
    });
    expect(value.supervise).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(scheduler.waits).toHaveLength(2));

    await value.monitor.stop();
    await running;
  });

  it("uses a fresh heartbeat for each sequential checkpoint", async () => {
    const scheduler = new ManualScheduler();
    const value = fixture({
      steps: [
        {
          state: "renewed",
          leaseExpiresAt: "2026-08-01T20:00:30.000Z",
        },
        {
          state: "renewed",
          leaseExpiresAt: "2026-08-01T20:01:00.000Z",
        },
      ],
      scheduler,
    });

    const first = await value.monitor.checkpoint();
    await vi.waitFor(() => expect(scheduler.waits).toHaveLength(1));
    const second = await value.monitor.checkpoint();
    expect(first).not.toBe(second);
    expect(value.supervise).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(scheduler.waits).toHaveLength(2));
    await value.monitor.stop();
  });

  it("settles checkpoint and monitor with the same cancellation object", async () => {
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

    const checkpoint = value.monitor.checkpoint();
    const running = value.monitor.start();
    const observation = await checkpoint;
    await expect(running).resolves.toBe(observation);
    await expect(value.monitor.checkpoint()).resolves.toBe(observation);
    expect(value.supervise).toHaveBeenCalledOnce();
  });

  it("settles checkpoint and monitor with the same stale object", async () => {
    const value = fixture({ steps: [{ state: "stale" }] });

    const checkpoint = value.monitor.checkpoint();
    const running = value.monitor.start();
    const observation = await checkpoint;
    await expect(running).resolves.toBe(observation);
    await expect(value.monitor.checkpoint()).resolves.toBe(observation);
    expect(value.revoke).toHaveBeenCalledOnce();
  });

  it("rejects checkpoint and monitor with the same uncertainty", async () => {
    const failure = new Error("secret checkpoint failure");
    const value = fixture({ steps: [failure] });

    const checkpoint = value.monitor.checkpoint();
    const running = value.monitor.start();
    const checkpointError = await checkpoint.catch((cause: unknown) => cause);
    const monitorError = await running.catch((cause: unknown) => cause);
    expect(checkpointError).toBe(monitorError);
    expect(checkpointError).toMatchObject({ code: "authority_uncertain" });
  });

  it("contains the background monitor rejection for checkpoint-only callers", async () => {
    const value = fixture({ steps: [new Error("heartbeat failed")] });

    await expect(value.monitor.checkpoint()).rejects.toMatchObject({
      code: "authority_uncertain",
    });
    await Promise.resolve();
  });

  it("lets an in-flight checkpoint settle before owner stop", async () => {
    const heartbeat = deferred<LeaseSupervisionResult>();
    const value = fixture({ steps: [heartbeat] });

    const checkpoint = value.monitor.checkpoint();
    const stopping = value.monitor.stop();
    heartbeat.resolve({
      state: "renewed",
      leaseExpiresAt: "2026-08-01T20:00:30.000Z",
    });

    await expect(checkpoint).resolves.toMatchObject({ state: "renewed" });
    await expect(stopping).resolves.toEqual({ state: "stopped" });
  });

  it("does not mask a settled scheduler failure with a checkpoint wake", async () => {
    const schedulerWait = deferred<void>();
    const scheduler: LeaseAuthorityScheduler = {
      wait: vi.fn(() => schedulerWait.promise),
    };
    const value = fixture({
      steps: [{ state: "renewed", leaseExpiresAt: "ignored" }],
      scheduler,
    });
    const running = value.monitor.start();
    await vi.waitFor(() => expect(scheduler.wait).toHaveBeenCalledOnce());

    const failure = new Error("scheduler failed before wake");
    schedulerWait.reject(failure);
    const checkpoint = value.monitor.checkpoint();
    const checkpointError = await checkpoint.catch((cause: unknown) => cause);
    const monitorError = await running.catch((cause: unknown) => cause);
    expect(checkpointError).toBe(monitorError);
    expect(monitorError).toMatchObject({
      code: "scheduler_failed",
      cause: failure,
    });
  });

  it("clones and freezes checkpoint renewal observations", async () => {
    const renewal = {
      state: "renewed" as const,
      leaseExpiresAt: "2026-08-01T20:00:30.000Z",
    };
    const value = fixture({ steps: [renewal] });

    const observation = await value.monitor.checkpoint();
    renewal.leaseExpiresAt = "mutated";
    expect(observation).toEqual({
      state: "renewed",
      leaseExpiresAt: "2026-08-01T20:00:30.000Z",
    });
    expect(Object.isFrozen(observation)).toBe(true);
    await value.monitor.stop();
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

  it("abandons before start without heartbeat or sandbox revocation", async () => {
    const value = fixture({});
    const abandoned = value.monitor.abandonPublication();

    const result = await abandoned;
    expect(result).toEqual({
      state: "abandoned",
      reason: "terminal_publication_failed",
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(value.monitor.start()).toBe(abandoned);
    expect(value.supervise).not.toHaveBeenCalled();
    expect(value.revoke).not.toHaveBeenCalled();
    await expect(value.monitor.checkpoint()).rejects.toMatchObject({
      code: "monitor_abandoned",
      message:
        "Lease authority monitor was abandoned after terminal publication failure.",
    });
  });

  it("abandons a scheduled wait without another heartbeat or revocation", async () => {
    const scheduler = new ManualScheduler();
    const value = fixture({
      steps: [{ state: "renewed", leaseExpiresAt: "ignored" }],
      scheduler,
    });
    const running = value.monitor.start();
    await vi.waitFor(() => expect(scheduler.waits).toHaveLength(1));

    const abandoning = value.monitor.abandonPublication();
    await expect(abandoning).resolves.toEqual({
      state: "abandoned",
      reason: "terminal_publication_failed",
    });
    expect(abandoning).toBe(running);
    expect(scheduler.waits[0]?.signal.aborted).toBe(true);
    expect(value.supervise).toHaveBeenCalledOnce();
    expect(value.revoke).not.toHaveBeenCalled();
  });

  it("lets an in-flight renewal settle before abandonment", async () => {
    const heartbeat = deferred<LeaseSupervisionResult>();
    const scheduler = new ManualScheduler();
    const value = fixture({ steps: [heartbeat], scheduler });
    const running = value.monitor.start();
    const abandoning = value.monitor.abandonPublication();
    let settled = false;
    void abandoning.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    heartbeat.resolve({ state: "renewed", leaseExpiresAt: "ignored" });
    await expect(abandoning).resolves.toMatchObject({ state: "abandoned" });
    expect(abandoning).toBe(running);
    expect(scheduler.waits).toHaveLength(0);
    expect(value.supervise).toHaveBeenCalledOnce();
    expect(value.revoke).not.toHaveBeenCalled();
  });

  it("settles a checkpoint already in flight before abandonment", async () => {
    const heartbeat = deferred<LeaseSupervisionResult>();
    const value = fixture({ steps: [heartbeat] });
    const checkpoint = value.monitor.checkpoint();
    const abandoning = value.monitor.abandonPublication();
    heartbeat.resolve({
      state: "renewed",
      leaseExpiresAt: "2026-08-01T20:00:30.000Z",
    });

    await expect(checkpoint).resolves.toEqual({
      state: "renewed",
      leaseExpiresAt: "2026-08-01T20:00:30.000Z",
    });
    await expect(abandoning).resolves.toMatchObject({ state: "abandoned" });
    await expect(value.monitor.checkpoint()).rejects.toMatchObject({
      code: "monitor_abandoned",
    });
  });

  it("uses the first clean or abandoned release intent for every caller", async () => {
    const stopped = fixture({});
    const clean = stopped.monitor.stop();
    const lateAbandon = stopped.monitor.abandonPublication();
    expect(lateAbandon).toBe(clean);
    await expect(lateAbandon).resolves.toEqual({ state: "stopped" });

    const abandoned = fixture({});
    const failStop = abandoned.monitor.abandonPublication();
    const lateStop = abandoned.monitor.stop();
    const duplicate = abandoned.monitor.abandonPublication();
    expect(lateStop).toBe(failStop);
    expect(duplicate).toBe(failStop);
    await expect(lateStop).resolves.toEqual({
      state: "abandoned",
      reason: "terminal_publication_failed",
    });
  });

  it("does not mask an already rejected scheduler with abandonment", async () => {
    const schedulerWait = deferred<void>();
    const scheduler: LeaseAuthorityScheduler = {
      wait: vi.fn(() => schedulerWait.promise),
    };
    const failure = new Error("scheduler failed before abandonment");
    const value = fixture({
      steps: [{ state: "renewed", leaseExpiresAt: "ignored" }],
      scheduler,
    });
    const running = value.monitor.start();
    await vi.waitFor(() => expect(scheduler.wait).toHaveBeenCalledOnce());

    schedulerWait.reject(failure);
    const abandoning = value.monitor.abandonPublication();

    expect(abandoning).toBe(running);
    await expect(abandoning).rejects.toMatchObject({
      code: "scheduler_failed",
      cause: failure,
    });
    expect(value.revoke).toHaveBeenCalledWith({
      reason: "scheduler_failure",
      gracePeriodMs: 0,
    });
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

  it("preserves cancellation, stale, and uncertainty over abandonment", async () => {
    const cancelled = deferred<LeaseSupervisionResult>();
    const cancelValue = fixture({ steps: [cancelled] });
    cancelValue.monitor.start();
    const cancelAbandon = cancelValue.monitor.abandonPublication();
    cancelled.resolve({
      state: "cancelled",
      leaseExpiresAt: "ignored",
      cancellation,
      termination,
    });
    await expect(cancelAbandon).resolves.toMatchObject({ state: "cancelled" });

    const stale = deferred<LeaseSupervisionResult>();
    const staleValue = fixture({ steps: [stale] });
    staleValue.monitor.start();
    const staleAbandon = staleValue.monitor.abandonPublication();
    stale.resolve({ state: "stale" });
    await expect(staleAbandon).resolves.toEqual({ state: "stale" });
    expect(staleValue.revoke).toHaveBeenCalledOnce();

    const uncertain = deferred<LeaseSupervisionResult>();
    const uncertainValue = fixture({ steps: [uncertain] });
    uncertainValue.monitor.start();
    const uncertainAbandon = uncertainValue.monitor.abandonPublication();
    const failure = new Error("heartbeat failed");
    uncertain.reject(failure);
    await expect(uncertainAbandon).rejects.toMatchObject({
      code: "authority_uncertain",
      cause: failure,
    });
    expect(uncertainValue.revoke).toHaveBeenCalledOnce();
  });

  it("preserves revocation failure over abandonment", async () => {
    const heartbeat = deferred<LeaseSupervisionResult>();
    const heartbeatFailure = new Error("heartbeat failed");
    const revocationFailure = new Error("sandbox revocation failed");
    const value = fixture({
      steps: [heartbeat],
      revoke: vi.fn(async () => Promise.reject(revocationFailure)),
    });
    value.monitor.start();
    const abandoning = value.monitor.abandonPublication();
    heartbeat.reject(heartbeatFailure);

    await expect(abandoning).rejects.toMatchObject({
      code: "revocation_failed",
    });
    const failure = await abandoning.catch((cause: unknown) => cause);
    expect((failure.cause as AggregateError).errors).toEqual([
      heartbeatFailure,
      revocationFailure,
    ]);
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
    await expect(value.monitor.checkpoint()).rejects.toMatchObject({
      code: "monitor_stopped",
      message: "Lease authority monitor is stopped.",
    });
  });

  it("releases before start without heartbeat or sandbox revocation", async () => {
    const value = fixture({});
    const releasing = value.monitor.releaseWithoutEvidence();

    const result = await releasing;
    expect(result).toEqual({
      state: "released",
      reason: "terminal_evidence_unavailable",
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(value.monitor.start()).toBe(releasing);
    expect(value.supervise).not.toHaveBeenCalled();
    expect(value.revoke).not.toHaveBeenCalled();
    await expect(value.monitor.checkpoint()).rejects.toMatchObject({
      code: "monitor_released",
      message:
        "Lease authority monitor was released without terminal evidence.",
    });
  });

  it("releases a scheduled wait without another heartbeat or revocation", async () => {
    const scheduler = new ManualScheduler();
    const value = fixture({
      steps: [{ state: "renewed", leaseExpiresAt: "ignored" }],
      scheduler,
    });
    const running = value.monitor.start();
    await vi.waitFor(() => expect(scheduler.waits).toHaveLength(1));

    const releasing = value.monitor.releaseWithoutEvidence();
    expect(releasing).toBe(running);
    await expect(releasing).resolves.toEqual({
      state: "released",
      reason: "terminal_evidence_unavailable",
    });
    expect(scheduler.waits[0]?.signal.aborted).toBe(true);
    expect(value.supervise).toHaveBeenCalledOnce();
    expect(value.revoke).not.toHaveBeenCalled();
  });

  it("lets an in-flight renewal settle before evidence-free release", async () => {
    const heartbeat = deferred<LeaseSupervisionResult>();
    const scheduler = new ManualScheduler();
    const value = fixture({ steps: [heartbeat], scheduler });
    const running = value.monitor.start();
    const releasing = value.monitor.releaseWithoutEvidence();
    let settled = false;
    void releasing.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    heartbeat.resolve({ state: "renewed", leaseExpiresAt: "ignored" });
    await expect(releasing).resolves.toEqual({
      state: "released",
      reason: "terminal_evidence_unavailable",
    });
    expect(releasing).toBe(running);
    expect(scheduler.waits).toHaveLength(0);
    expect(value.supervise).toHaveBeenCalledOnce();
    expect(value.revoke).not.toHaveBeenCalled();
  });

  it("preserves cancellation and stale outcomes over evidence-free release", async () => {
    const cancelled = deferred<LeaseSupervisionResult>();
    const cancelValue = fixture({ steps: [cancelled] });
    cancelValue.monitor.start();
    const cancelRelease = cancelValue.monitor.releaseWithoutEvidence();
    cancelled.resolve({
      state: "cancelled",
      leaseExpiresAt: "ignored",
      cancellation,
      termination,
    });
    await expect(cancelRelease).resolves.toMatchObject({ state: "cancelled" });
    expect(cancelValue.revoke).not.toHaveBeenCalled();

    const stale = deferred<LeaseSupervisionResult>();
    const staleValue = fixture({ steps: [stale] });
    staleValue.monitor.start();
    const staleRelease = staleValue.monitor.releaseWithoutEvidence();
    stale.resolve({ state: "stale" });
    await expect(staleRelease).resolves.toEqual({ state: "stale" });
    expect(staleValue.revoke).toHaveBeenCalledWith({
      reason: "lease_stale",
      gracePeriodMs: 0,
    });
  });

  it("preserves heartbeat and revocation uncertainty over evidence-free release", async () => {
    const heartbeat = deferred<LeaseSupervisionResult>();
    const heartbeatFailure = new Error("secret heartbeat failure");
    const revocationFailure = new Error("secret revocation failure");
    const value = fixture({
      steps: [heartbeat],
      revoke: vi.fn(async () => Promise.reject(revocationFailure)),
    });
    value.monitor.start();
    const releasing = value.monitor.releaseWithoutEvidence();
    heartbeat.reject(heartbeatFailure);

    const failure = await releasing.catch((cause: unknown) => cause);
    expect(failure).toMatchObject({
      code: "revocation_failed",
      message: "Lease authority was lost and local revocation failed.",
    });
    expect((failure.cause as AggregateError).errors).toEqual([
      heartbeatFailure,
      revocationFailure,
    ]);
    expect((failure as Error).message).not.toContain("secret");
  });

  it("preserves heartbeat uncertainty over evidence-free release", async () => {
    const heartbeat = deferred<LeaseSupervisionResult>();
    const heartbeatFailure = new Error("secret heartbeat failure");
    const value = fixture({ steps: [heartbeat] });
    const running = value.monitor.start();
    const releasing = value.monitor.releaseWithoutEvidence();
    heartbeat.reject(heartbeatFailure);

    expect(releasing).toBe(running);
    await expect(releasing).rejects.toMatchObject({
      code: "authority_uncertain",
      message: "Lease authority became uncertain.",
      cause: heartbeatFailure,
    });
    expect(value.revoke).toHaveBeenCalledWith({
      reason: "lease_uncertain",
      gracePeriodMs: 0,
    });
    await expect(releasing).rejects.not.toThrow("secret heartbeat failure");
  });

  it("does not mask an already failing scheduler with evidence-free release", async () => {
    const schedulerWait = deferred<void>();
    const scheduler: LeaseAuthorityScheduler = {
      wait: vi.fn(() => schedulerWait.promise),
    };
    const schedulerFailure = new Error("secret scheduler failure");
    const value = fixture({
      steps: [{ state: "renewed", leaseExpiresAt: "ignored" }],
      scheduler,
    });
    const running = value.monitor.start();
    await vi.waitFor(() => expect(scheduler.wait).toHaveBeenCalledOnce());

    const releasing = value.monitor.releaseWithoutEvidence();
    schedulerWait.reject(schedulerFailure);

    expect(releasing).toBe(running);
    await expect(releasing).rejects.toMatchObject({
      code: "scheduler_failed",
      message: "Lease heartbeat scheduling failed.",
      cause: schedulerFailure,
    });
    expect(value.revoke).toHaveBeenCalledWith({
      reason: "scheduler_failure",
      gracePeriodMs: 0,
    });
    await expect(releasing).rejects.not.toThrow("secret scheduler failure");
  });

  it("settles an in-flight checkpoint before evidence-free release", async () => {
    const heartbeat = deferred<LeaseSupervisionResult>();
    const value = fixture({ steps: [heartbeat] });
    const checkpoint = value.monitor.checkpoint();
    const releasing = value.monitor.releaseWithoutEvidence();
    heartbeat.resolve({
      state: "renewed",
      leaseExpiresAt: "2026-08-01T20:00:30.000Z",
    });

    await expect(checkpoint).resolves.toEqual({
      state: "renewed",
      leaseExpiresAt: "2026-08-01T20:00:30.000Z",
    });
    await expect(releasing).resolves.toMatchObject({ state: "released" });
    await expect(value.monitor.checkpoint()).rejects.toMatchObject({
      code: "monitor_released",
    });
  });

  it("seals a queued checkpoint when release wins the scheduled-wait race", async () => {
    const scheduler = new ManualScheduler();
    const value = fixture({
      steps: [{ state: "renewed", leaseExpiresAt: "ignored" }],
      scheduler,
    });
    const running = value.monitor.start();
    await vi.waitFor(() => expect(scheduler.waits).toHaveLength(1));

    const checkpoint = value.monitor.checkpoint();
    const releasing = value.monitor.releaseWithoutEvidence();

    await expect(checkpoint).rejects.toMatchObject({
      code: "monitor_released",
      message:
        "Lease authority monitor was released without terminal evidence.",
    });
    await expect(releasing).resolves.toMatchObject({ state: "released" });
    expect(releasing).toBe(running);
    expect(value.supervise).toHaveBeenCalledOnce();
    expect(value.revoke).not.toHaveBeenCalled();
  });

  it("uses the first release, stop, or abandonment intent for every caller", async () => {
    const released = fixture({});
    const release = released.monitor.releaseWithoutEvidence();
    expect(released.monitor.stop()).toBe(release);
    expect(released.monitor.abandonPublication()).toBe(release);
    expect(released.monitor.releaseWithoutEvidence()).toBe(release);
    await expect(release).resolves.toMatchObject({ state: "released" });

    const stopped = fixture({});
    const stop = stopped.monitor.stop();
    expect(stopped.monitor.releaseWithoutEvidence()).toBe(stop);
    await expect(stop).resolves.toEqual({ state: "stopped" });

    const abandoned = fixture({});
    const abandon = abandoned.monitor.abandonPublication();
    expect(abandoned.monitor.releaseWithoutEvidence()).toBe(abandon);
    await expect(abandon).resolves.toMatchObject({ state: "abandoned" });
  });

  it("cannot replace an already terminal authority outcome with release", async () => {
    const staleValue = fixture({ steps: [{ state: "stale" }] });
    const staleOperation = staleValue.monitor.start();
    await expect(staleOperation).resolves.toEqual({ state: "stale" });
    expect(staleValue.monitor.releaseWithoutEvidence()).toBe(staleOperation);
    await expect(staleValue.monitor.releaseWithoutEvidence()).resolves.toEqual({
      state: "stale",
    });

    const heartbeatFailure = new Error("terminal heartbeat failure");
    const uncertainValue = fixture({ steps: [heartbeatFailure] });
    const uncertainOperation = uncertainValue.monitor.start();
    await expect(uncertainOperation).rejects.toMatchObject({
      code: "authority_uncertain",
      cause: heartbeatFailure,
    });
    expect(uncertainValue.monitor.releaseWithoutEvidence()).toBe(
      uncertainOperation,
    );
    await expect(
      uncertainValue.monitor.releaseWithoutEvidence(),
    ).rejects.toMatchObject({ code: "authority_uncertain" });
  });
});
