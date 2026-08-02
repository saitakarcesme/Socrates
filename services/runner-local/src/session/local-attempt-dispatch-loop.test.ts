import { runnerExecutionV1Schema } from "@socrates/contracts";
import { describe, expect, it, vi } from "vitest";

import taskFixture from "../../../../packages/contracts/fixtures/runner/task-v2.json";
import { attemptKeyFor } from "../spool/codec";
import { NodeLeaseAuthorityScheduler } from "../supervision/node-scheduler";
import type { StartupGatedAttemptDispatchResult } from "./startup-gated-attempt-dispatcher";
import {
  LocalAttemptDispatchLoop,
  LocalAttemptDispatchLoopError,
  type LocalAttemptDispatchDelay,
  type LocalAttemptDispatchObserver,
  type LocalAttemptDispatchOwner,
} from "./local-attempt-dispatch-loop";

const deliveryId = "40000000-0000-4000-8000-000000000004";
const execution = runnerExecutionV1Schema.parse({
  version: "1",
  lease: {
    version: "1",
    runnerId: "10000000-0000-4000-8000-000000000001",
    taskId: taskFixture.taskId,
    attemptId: "20000000-0000-4000-8000-000000000002",
    fence: 4,
    leasedUntil: "2026-08-02T02:00:00.000Z",
  },
  task: taskFixture,
});

function deepFreeze<T>(candidate: T): T {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Object.isFrozen(candidate)
  ) {
    return candidate;
  }
  for (const value of Object.values(candidate)) deepFreeze(value);
  return Object.freeze(candidate);
}

const activeWork = deepFreeze({
  deliveryId,
  taskId: execution.lease.taskId,
  attemptId: execution.lease.attemptId,
  state: "execution_started" as const,
  admittedAt: "2026-08-02T00:00:00.000Z",
  claimedAt: "2026-08-02T00:00:01.000Z",
  executionStartedAt: "2026-08-02T00:00:02.000Z",
});

const validResults = {
  idle: deepFreeze({ state: "idle" as const }),
  rejected: deepFreeze({
    state: "rejected" as const,
    work: {
      deliveryId,
      taskId: execution.lease.taskId,
      attemptId: execution.lease.attemptId,
      state: "rejected" as const,
      admittedAt: "2026-08-02T00:00:00.000Z",
      rejectedAt: "2026-08-02T00:00:03.000Z",
      rejection: {
        reason: "control_plane_conflict" as const,
        status: 409 as const,
        apiCode: "resource_conflict",
        requestId: "request-1",
      },
    },
    recovered: false,
  }),
  indeterminate: deepFreeze({
    state: "indeterminate" as const,
    execution,
    work: activeWork,
    recovered: true as const,
    observedAt: "2026-08-02T00:00:04.000Z",
    leaseExpiresAt: "2026-08-02T00:00:30.000Z",
  }),
  retired: deepFreeze({
    state: "retired" as const,
    execution,
    work: {
      ...activeWork,
      state: "retired" as const,
      retiredAt: "2026-08-02T00:00:05.000Z",
      retirement: {
        observedAt: "2026-08-02T00:00:04.000Z",
        reason: "lease_expired_requeued" as const,
      },
    },
    recovered: true,
  }),
  completed: deepFreeze({
    state: "completed" as const,
    execution,
    work: {
      ...activeWork,
      state: "completed" as const,
      completedAt: "2026-08-02T00:00:05.000Z",
      completion: {
        attemptKey: attemptKeyFor(execution),
        acknowledgedSequence: 2,
      },
    },
    recovered: true,
  }),
  settled: deepFreeze({
    state: "settled" as const,
    path: "fresh" as const,
    deliveryId,
    execution,
    result: {
      state: "no_evidence" as const,
      reason: "observation_uncertain" as const,
      authority: {
        state: "released" as const,
        reason: "terminal_evidence_unavailable" as const,
      },
    },
  }),
  settledCompleted: deepFreeze({
    state: "settled" as const,
    path: "fresh" as const,
    deliveryId,
    execution,
    result: {
      state: "completed" as const,
      publication: {
        state: "completed" as const,
        publication: "appended" as const,
        work: {
          ...activeWork,
          state: "completed" as const,
          completedAt: "2026-08-02T00:00:05.000Z",
          completion: {
            attemptKey: attemptKeyFor(execution),
            acknowledgedSequence: 2,
          },
        },
      },
      authority: { state: "stopped" as const },
    },
  }),
} satisfies Record<string, StartupGatedAttemptDispatchResult>;

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

class ManualDelay implements LocalAttemptDispatchDelay {
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

type DispatchStep =
  | StartupGatedAttemptDispatchResult
  | Error
  | Deferred<StartupGatedAttemptDispatchResult>;

function operation<T>(candidate: T | Error | Deferred<T>): Promise<T> {
  if (candidate instanceof Error) return Promise.reject(candidate);
  if (
    typeof candidate === "object" &&
    candidate !== null &&
    "promise" in candidate
  ) {
    return candidate.promise;
  }
  return Promise.resolve(candidate);
}

function harness(
  options: {
    steps?: DispatchStep[];
    delay?: LocalAttemptDispatchDelay;
    observe?: LocalAttemptDispatchObserver["observe"];
    pollIntervalMs?: number;
  } = {},
) {
  const steps = [...(options.steps ?? [validResults.idle])];
  const order: string[] = [];
  const dispatchNext = vi.fn(async () => {
    order.push("dispatch");
    const step = steps.shift();
    if (step === undefined) throw new Error("Unexpected dispatch.");
    return operation(step);
  });
  const delay = options.delay ?? new ManualDelay();
  const originalWait = delay.wait.bind(delay);
  const wait = vi.spyOn(delay, "wait").mockImplementation(async (...args) => {
    order.push("delay");
    return originalWait(...args);
  });
  const sourceObserve = options.observe ?? (async () => Promise.resolve());
  const observe = vi.fn(async (result: StartupGatedAttemptDispatchResult) => {
    order.push(`observe:${result.state}`);
    return sourceObserve(result);
  });
  const loop = new LocalAttemptDispatchLoop({
    owner: { dispatchNext },
    delay: { wait },
    observer: { observe },
    pollIntervalMs: options.pollIntervalMs ?? 25,
  });
  return { delay, dispatchNext, loop, observe, order, wait };
}

describe("LocalAttemptDispatchLoop", () => {
  it("constructs without dispatch, observation, or delay effects", () => {
    const value = harness();
    expect(value.dispatchNext).not.toHaveBeenCalled();
    expect(value.observe).not.toHaveBeenCalled();
    expect(value.wait).not.toHaveBeenCalled();
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5, 2_147_483_648])(
    "rejects invalid poll interval %s during inert construction",
    (pollIntervalMs) => {
      expect(() => harness({ pollIntervalMs })).toThrowError(
        LocalAttemptDispatchLoopError,
      );
    },
  );

  it.each([
    { owner: {}, delay: { wait: vi.fn() }, observer: { observe: vi.fn() } },
    {
      owner: { dispatchNext: vi.fn() },
      delay: {},
      observer: { observe: vi.fn() },
    },
    {
      owner: { dispatchNext: vi.fn() },
      delay: { wait: vi.fn() },
      observer: {},
    },
  ])("rejects malformed dependency %# during construction", (dependencies) => {
    expect(
      () =>
        new LocalAttemptDispatchLoop({
          ...(dependencies as never),
          pollIntervalMs: 1,
        }),
    ).toThrowError(LocalAttemptDispatchLoopError);
  });

  it("redacts a throwing dependency accessor while retaining its cause", () => {
    const cause = new Error("private dependency details");
    const owner = Object.defineProperty({}, "dispatchNext", {
      get: () => {
        throw cause;
      },
    });

    try {
      new LocalAttemptDispatchLoop({
        owner: owner as LocalAttemptDispatchOwner,
        delay: { wait: vi.fn() },
        observer: { observe: vi.fn() },
        pollIntervalMs: 1,
      });
      throw new Error("Expected construction failure.");
    } catch (error) {
      expect(error).toMatchObject({
        code: "invalid_dependency",
        cause,
        message: "Local attempt dispatch dependency is invalid.",
      });
      expect(String(error)).not.toContain("private dependency details");
    }
  });

  it.each([
    "stop",
    Symbol("stop"),
    Object.freeze({ state: "stop" }),
    new Error("stop"),
  ])("stops without effects when already aborted with %#", async (reason) => {
    const value = harness();
    const controller = new AbortController();
    controller.abort(reason);

    await expect(value.loop.run(controller.signal)).resolves.toEqual({
      state: "stopped",
    });
    expect(value.dispatchNext).not.toHaveBeenCalled();
    expect(value.observe).not.toHaveBeenCalled();
    expect(value.wait).not.toHaveBeenCalled();
  });

  it("preserves the default DOMException shutdown without exposing it", async () => {
    const value = harness();
    const controller = new AbortController();
    controller.abort();

    const result = await value.loop.run(controller.signal);
    expect(controller.signal.reason).toBeInstanceOf(DOMException);
    expect(result).toEqual({ state: "stopped" });
    expect(Object.keys(result)).toEqual(["state"]);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("rejects an invalid signal before any lifecycle effect", async () => {
    const value = harness();

    await expect(value.loop.run({} as AbortSignal)).rejects.toMatchObject({
      code: "invalid_configuration",
    });
    expect(value.dispatchNext).not.toHaveBeenCalled();
    expect(value.observe).not.toHaveBeenCalled();
    expect(value.wait).not.toHaveBeenCalled();
  });

  it.each([
    "active stop",
    Symbol("active stop"),
    Object.freeze({ state: "active stop" }),
    new Error("active stop"),
  ])("classifies exact active dispatch abort %# as stop", async (reason) => {
    const controller = new AbortController();
    const dispatchNext = vi.fn(
      async () =>
        new Promise<StartupGatedAttemptDispatchResult>((_, reject) => {
          controller.signal.addEventListener(
            "abort",
            () => reject(controller.signal.reason),
            { once: true },
          );
        }),
    );
    const observe = vi.fn(async () => undefined);
    const wait = vi.fn(async () => undefined);
    const loop = new LocalAttemptDispatchLoop({
      owner: { dispatchNext },
      delay: { wait },
      observer: { observe },
      pollIntervalMs: 1,
    });
    const running = loop.run(controller.signal);

    controller.abort(reason);
    await expect(running).resolves.toEqual({ state: "stopped" });
    expect(observe).not.toHaveBeenCalled();
    expect(wait).not.toHaveBeenCalled();
  });

  it("shares one exact retained operation across repeated run calls", async () => {
    const pending = deferred<StartupGatedAttemptDispatchResult>();
    const value = harness({ steps: [pending] });
    const controller = new AbortController();
    const running = value.loop.run(controller.signal);

    expect(value.loop.run(new AbortController().signal)).toBe(running);
    const reason = Symbol("stop");
    controller.abort(reason);
    pending.reject(reason);
    await expect(running).resolves.toEqual({ state: "stopped" });
    expect(value.dispatchNext).toHaveBeenCalledOnce();
  });

  it("observes idle before one bounded delay and never busy-spins", async () => {
    const delay = new ManualDelay();
    const value = harness({ delay });
    const controller = new AbortController();
    const running = value.loop.run(controller.signal);

    await vi.waitFor(() => expect(delay.waits).toHaveLength(1));
    expect(value.order).toEqual(["dispatch", "observe:idle", "delay"]);
    expect(delay.waits[0]?.delayMs).toBe(25);
    expect(value.dispatchNext).toHaveBeenCalledOnce();
    controller.abort(Symbol("stop"));
    await expect(running).resolves.toEqual({ state: "stopped" });
  });

  it("delays indeterminate reconciliation without consulting local time", async () => {
    const wallClock = vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("wall clock forbidden");
    });
    const delay = new ManualDelay();
    const value = harness({ steps: [validResults.indeterminate], delay });
    const controller = new AbortController();
    const running = value.loop.run(controller.signal);

    await vi.waitFor(() => expect(delay.waits).toHaveLength(1));
    expect(wallClock).not.toHaveBeenCalled();
    expect(value.order).toEqual(["dispatch", "observe:indeterminate", "delay"]);
    controller.abort(Symbol("stop"));
    await running;
    wallClock.mockRestore();
  });

  it.each([
    validResults.rejected,
    validResults.retired,
    validResults.completed,
    validResults.settled,
    validResults.settledCompleted,
  ])("advances immediately after closed result $state", async (first) => {
    const pending = deferred<StartupGatedAttemptDispatchResult>();
    const value = harness({ steps: [first, pending] });
    const controller = new AbortController();
    const running = value.loop.run(controller.signal);

    await vi.waitFor(() => expect(value.dispatchNext).toHaveBeenCalledTimes(2));
    expect(value.wait).not.toHaveBeenCalled();
    expect(value.order.slice(0, 3)).toEqual([
      "dispatch",
      `observe:${first.state}`,
      "dispatch",
    ]);
    const reason = Symbol("stop");
    controller.abort(reason);
    pending.reject(reason);
    await running;
  });

  it("waits for owned settlement and observation before shutdown", async () => {
    const pending = deferred<StartupGatedAttemptDispatchResult>();
    const value = harness({ steps: [pending] });
    const controller = new AbortController();
    const running = value.loop.run(controller.signal);

    controller.abort(Symbol("shutdown during session"));
    pending.resolve(validResults.settled);
    await expect(running).resolves.toEqual({ state: "stopped" });
    expect(value.order).toEqual(["dispatch", "observe:settled"]);
    expect(value.wait).not.toHaveBeenCalled();
  });

  it("waits for in-flight observation before shutdown", async () => {
    const observation = deferred<void>();
    const value = harness({
      steps: [validResults.idle],
      observe: async () => observation.promise,
    });
    const controller = new AbortController();
    const running = value.loop.run(controller.signal);
    await vi.waitFor(() => expect(value.observe).toHaveBeenCalledOnce());

    controller.abort(Symbol("shutdown during observation"));
    expect(value.wait).not.toHaveBeenCalled();
    observation.resolve();
    await expect(running).resolves.toEqual({ state: "stopped" });
    expect(value.wait).not.toHaveBeenCalled();
  });

  it("uses the real Node scheduler for interruptible idle delay", async () => {
    const controller = new AbortController();
    const reason = Symbol("stop after real delay");
    const dispatchNext = vi
      .fn<LocalAttemptDispatchOwner["dispatchNext"]>()
      .mockResolvedValueOnce(validResults.idle)
      .mockImplementationOnce(async () => {
        controller.abort(reason);
        return Promise.reject(reason);
      });
    const observe = vi.fn(async () => undefined);
    const loop = new LocalAttemptDispatchLoop({
      owner: { dispatchNext },
      delay: new NodeLeaseAuthorityScheduler(),
      observer: { observe },
      pollIntervalMs: 1,
    });

    await expect(loop.run(controller.signal)).resolves.toEqual({
      state: "stopped",
    });
    expect(dispatchNext).toHaveBeenCalledTimes(2);
    expect(observe).toHaveBeenCalledOnce();
  });

  it.each([
    ["dispatch_failed", "dispatch"],
    ["observation_failed", "observation"],
    ["delay_failed", "delay"],
  ] as const)(
    "retains fixed %s failure without retry",
    async (code, boundary) => {
      const cause = new Error(`private ${boundary} details`);
      const dispatchNext = vi.fn(async () => {
        if (boundary === "dispatch") return Promise.reject(cause);
        return validResults.idle;
      });
      const observe = vi.fn(async () => {
        if (boundary === "observation") return Promise.reject(cause);
      });
      const wait = vi.fn(async () => {
        if (boundary === "delay") return Promise.reject(cause);
      });
      const loop = new LocalAttemptDispatchLoop({
        owner: { dispatchNext },
        delay: { wait },
        observer: { observe },
        pollIntervalMs: 1,
      });
      const running = loop.run(new AbortController().signal);

      await expect(running).rejects.toMatchObject({ code, cause });
      await expect(
        loop.run(new AbortController().signal),
      ).rejects.toBeInstanceOf(LocalAttemptDispatchLoopError);
      expect(dispatchNext).toHaveBeenCalledOnce();
    },
  );

  it.each([
    null,
    Object.freeze({}),
    Object.freeze({ state: "idle", extra: true }),
    { state: "idle" },
    Object.freeze({ state: "recovery_pending" }),
  ])("fails closed on invalid result %#", async (candidate) => {
    const dispatchNext = vi.fn(async () => candidate as never);
    const observe = vi.fn(async () => undefined);
    const wait = vi.fn(async () => undefined);
    const loop = new LocalAttemptDispatchLoop({
      owner: { dispatchNext },
      delay: { wait },
      observer: { observe },
      pollIntervalMs: 1,
    });

    await expect(loop.run(new AbortController().signal)).rejects.toMatchObject({
      code: "invalid_result",
      message: "Local attempt dispatch result is invalid.",
    });
    expect(observe).not.toHaveBeenCalled();
    expect(wait).not.toHaveBeenCalled();
  });

  it("rejects settled delivery identity drift", async () => {
    const candidate = deepFreeze({
      ...validResults.settledCompleted,
      deliveryId: "50000000-0000-4000-8000-000000000005",
    });
    const loop = new LocalAttemptDispatchLoop({
      owner: { dispatchNext: vi.fn(async () => candidate) },
      delay: { wait: vi.fn() },
      observer: { observe: vi.fn() },
      pollIntervalMs: 1,
    });

    await expect(loop.run(new AbortController().signal)).rejects.toMatchObject({
      code: "invalid_result",
    });
  });

  it("captures dependency methods against later mutation", async () => {
    const controller = new AbortController();
    const reason = Symbol("captured stop");
    const dispatchNext = vi.fn(async () => validResults.idle);
    const wait = vi.fn(async () => {
      controller.abort(reason);
      return Promise.reject(reason);
    });
    const observe = vi.fn(async () => undefined);
    const owner: LocalAttemptDispatchOwner = { dispatchNext };
    const delay: LocalAttemptDispatchDelay = { wait };
    const observer: LocalAttemptDispatchObserver = { observe };
    const loop = new LocalAttemptDispatchLoop({
      owner,
      delay,
      observer,
      pollIntervalMs: 1,
    });
    owner.dispatchNext = vi.fn(async () =>
      Promise.reject(new Error("mutated")),
    );
    delay.wait = vi.fn(async () => Promise.reject(new Error("mutated")));
    observer.observe = vi.fn(async () => Promise.reject(new Error("mutated")));

    await expect(loop.run(controller.signal)).resolves.toEqual({
      state: "stopped",
    });
    expect(dispatchNext).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledOnce();
  });
});
