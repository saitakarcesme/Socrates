import { runnerExecutionV1Schema } from "@socrates/contracts";
import { describe, expect, it, vi } from "vitest";

import { RunnerStartupRecoveryBarrier } from "../execution/startup-recovery-barrier";
import { attemptKeyFor } from "../spool/codec";
import type { WorkJournalState } from "../work-journal/contracts";
import type { WorkAdmissionResult } from "../work-journal/coordinator";
import type { TerminalPublicationOwnershipResult } from "../work-journal/terminal-publication-owner";
import type { FreshAttemptSessionResult } from "./fresh-attempt-session";
import {
  StartupGatedAttemptDispatcher,
  StartupGatedAttemptDispatcherError,
  type StartupGatedAttemptComposition,
} from "./startup-gated-attempt-dispatcher";
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

function activeWork(
  state: "claimed" | "execution_started" = "claimed",
): WorkJournalState {
  return Object.freeze({
    deliveryId,
    taskId: execution.lease.taskId,
    attemptId: execution.lease.attemptId,
    state,
    admittedAt: "2026-08-01T00:00:00.000Z",
    claimedAt: "2026-08-01T00:00:01.000Z",
    ...(state === "execution_started"
      ? { executionStartedAt: "2026-08-01T00:00:02.000Z" }
      : {}),
  });
}

function completedWork(
  baseline: WorkJournalState = activeWork("execution_started"),
): WorkJournalState {
  return Object.freeze({
    ...baseline,
    state: "completed",
    completedAt: "2026-08-01T00:00:03.000Z",
    completion: {
      attemptKey: attemptKeyFor(execution),
      acknowledgedSequence: 2,
    },
  });
}

function ready(recovered = false): WorkAdmissionResult {
  return Object.freeze({
    state: "ready",
    deliveryId,
    execution,
    recovered,
  });
}

function recoveryPending(): WorkAdmissionResult {
  return Object.freeze({
    state: "recovery_pending",
    deliveryId,
    execution,
    work: activeWork(),
    recovered: true,
    observedAt: "2026-08-01T00:00:04.000Z",
    leaseExpiresAt: "2026-08-01T00:00:30.000Z",
  });
}

function completedOwnership(
  authority: TerminalPublicationOwnershipResult["authority"] = {
    state: "stopped",
  },
): TerminalPublicationOwnershipResult {
  return Object.freeze({
    state: "completed",
    publication: {
      state: "completed",
      publication: "appended",
      work: completedWork(),
    },
    authority,
  });
}

function noEvidence(): FreshAttemptSessionResult {
  return Object.freeze({
    state: "no_evidence",
    reason: "observation_uncertain",
    authority: {
      state: "released",
      reason: "terminal_evidence_unavailable",
    },
  });
}

type AdmissionStep =
  WorkAdmissionResult | Error | Deferred<WorkAdmissionResult>;
type FreshStep =
  FreshAttemptSessionResult | Error | Deferred<FreshAttemptSessionResult>;
type RestartStep =
  | TerminalPublicationOwnershipResult
  | Error
  | Deferred<TerminalPublicationOwnershipResult>;

function step<T>(candidate: T | Error | Deferred<T>): Promise<T> {
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
    admissions?: AdmissionStep[];
    fresh?: FreshStep[];
    restart?: RestartStep[];
    sandboxRecovery?: () => Promise<number>;
    sourceRecovery?: () => Promise<number>;
    compose?: () => Promise<StartupGatedAttemptComposition>;
  } = {},
) {
  const order: string[] = [];
  const admissions = [...(options.admissions ?? [{ state: "idle" }])];
  const fresh = [...(options.fresh ?? [completedOwnership()])];
  const restart = [...(options.restart ?? [completedOwnership()])];
  const sandboxes = {
    recoverOwned: vi.fn(
      options.sandboxRecovery ??
        (async () => {
          order.push("sandboxes");
          return 2;
        }),
    ),
  };
  const sources = {
    recoverOwned: vi.fn(
      options.sourceRecovery ??
        (async () => {
          order.push("sources");
          return 3;
        }),
    ),
  };
  const prepareNext = vi.fn(async () => {
    order.push("admission");
    const candidate = admissions.shift();
    if (candidate === undefined) throw new Error("Unexpected admission call.");
    return step(candidate);
  });
  const freshSettle = vi.fn(async () => {
    order.push("fresh.settle");
    const candidate = fresh.shift();
    if (candidate === undefined)
      throw new Error("Unexpected fresh settlement.");
    return step(candidate);
  });
  const restartSettle = vi.fn(async () => {
    order.push("restart.settle");
    const candidate = restart.shift();
    if (candidate === undefined)
      throw new Error("Unexpected restart settlement.");
    return step(candidate);
  });
  const createFresh = vi.fn(() => {
    order.push("fresh.create");
    return { settle: freshSettle };
  });
  const createRestartRecovery = vi.fn(() => {
    order.push("restart.create");
    return { settle: restartSettle };
  });
  const composition: StartupGatedAttemptComposition = {
    admission: { prepareNext },
    createFresh,
    createRestartRecovery,
  };
  const compose = vi.fn(
    options.compose ??
      (async () => {
        order.push("compose");
        return composition;
      }),
  );
  const startup = new RunnerStartupRecoveryBarrier({ sandboxes, sources });
  const dispatcher = new StartupGatedAttemptDispatcher({
    startup,
    composition: { compose },
  });
  return {
    compose,
    composition,
    createFresh,
    createRestartRecovery,
    dispatcher,
    freshSettle,
    order,
    prepareNext,
    restartSettle,
    sandboxes,
    sources,
  };
}

describe("StartupGatedAttemptDispatcher", () => {
  it("has no startup, composition, admission, or session effect at construction", () => {
    const value = harness();

    expect(value.sandboxes.recoverOwned).not.toHaveBeenCalled();
    expect(value.sources.recoverOwned).not.toHaveBeenCalled();
    expect(value.compose).not.toHaveBeenCalled();
    expect(value.prepareNext).not.toHaveBeenCalled();
    expect(value.createFresh).not.toHaveBeenCalled();
    expect(value.createRestartRecovery).not.toHaveBeenCalled();
  });

  it("gates a fresh session behind ordered startup and returns exact ownership", async () => {
    const value = harness({ admissions: [ready()] });
    const signal = new AbortController().signal;

    const result = await value.dispatcher.dispatchNext(signal);

    expect(value.order).toEqual([
      "sandboxes",
      "sources",
      "compose",
      "admission",
      "fresh.create",
      "fresh.settle",
    ]);
    expect(value.prepareNext).toHaveBeenCalledWith(signal);
    expect(value.createFresh).toHaveBeenCalledWith(ready());
    expect(value.createRestartRecovery).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      state: "settled",
      path: "fresh",
      deliveryId,
      execution,
      result: { state: "completed", authority: { state: "stopped" } },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.execution)).toBe(true);
    expect(Object.isFrozen(result.result)).toBe(true);
  });

  it("routes only recovery_pending to restart publication ownership", async () => {
    const value = harness({ admissions: [recoveryPending()] });

    await expect(value.dispatcher.dispatchNext()).resolves.toMatchObject({
      state: "settled",
      path: "restart_recovery",
      deliveryId,
      result: { state: "completed" },
    });
    expect(value.order).toEqual([
      "sandboxes",
      "sources",
      "compose",
      "admission",
      "restart.create",
      "restart.settle",
    ]);
    expect(value.createFresh).not.toHaveBeenCalled();
    expect(value.createRestartRecovery).toHaveBeenCalledWith(recoveryPending());
  });

  it("accepts an exact fresh no-evidence settlement", async () => {
    const value = harness({ admissions: [ready()], fresh: [noEvidence()] });

    await expect(value.dispatcher.dispatchNext()).resolves.toMatchObject({
      state: "settled",
      path: "fresh",
      result: {
        state: "no_evidence",
        reason: "observation_uncertain",
        authority: { state: "released" },
      },
    });
  });

  it("routes a safely reconciled ready handoff through fresh execution", async () => {
    const value = harness({ admissions: [ready(true)] });

    await expect(value.dispatcher.dispatchNext()).resolves.toMatchObject({
      state: "settled",
      path: "fresh",
    });
    expect(value.createFresh).toHaveBeenCalledWith(ready(true));
    expect(value.createRestartRecovery).not.toHaveBeenCalled();
  });

  it.each([
    ["idle", { state: "idle" }],
    [
      "rejected",
      {
        state: "rejected",
        work: {
          deliveryId,
          taskId: execution.lease.taskId,
          attemptId: execution.lease.attemptId,
          state: "rejected",
          admittedAt: "2026-08-01T00:00:00.000Z",
          rejectedAt: "2026-08-01T00:00:01.000Z",
          rejection: {
            reason: "control_plane_conflict",
            status: 409,
            apiCode: "resource_conflict",
            requestId: "request-1",
          },
        },
        recovered: false,
      },
    ],
    [
      "indeterminate",
      {
        state: "indeterminate",
        execution,
        work: activeWork("execution_started"),
        recovered: true,
        observedAt: "2026-08-01T00:00:04.000Z",
        leaseExpiresAt: "2026-08-01T00:00:30.000Z",
      },
    ],
    [
      "retired",
      {
        state: "retired",
        execution,
        work: {
          ...activeWork(),
          state: "retired",
          retiredAt: "2026-08-01T00:00:05.000Z",
          retirement: {
            observedAt: "2026-08-01T00:00:04.000Z",
            reason: "task_terminal",
          },
        },
        recovered: true,
      },
    ],
    [
      "completed",
      {
        state: "completed",
        execution,
        work: completedWork(),
        recovered: true,
      },
    ],
  ] as const)(
    "returns %s without constructing a session",
    async (_label, admission) => {
      const value = harness({ admissions: [admission as WorkAdmissionResult] });

      const result = await value.dispatcher.dispatchNext();

      expect(result).toEqual(admission);
      expect(Object.isFrozen(result)).toBe(true);
      expect(value.createFresh).not.toHaveBeenCalled();
      expect(value.createRestartRecovery).not.toHaveBeenCalled();
    },
  );

  it("serializes a second admission behind complete first-session settlement", async () => {
    const pending = deferred<FreshAttemptSessionResult>();
    const value = harness({
      admissions: [ready(), { state: "idle" }],
      fresh: [pending],
    });

    const first = value.dispatcher.dispatchNext();
    const second = value.dispatcher.dispatchNext();
    await vi.waitFor(() => expect(value.freshSettle).toHaveBeenCalledOnce());
    expect(value.prepareNext).toHaveBeenCalledOnce();

    pending.resolve(completedOwnership());
    await expect(first).resolves.toMatchObject({ state: "settled" });
    await expect(second).resolves.toEqual({ state: "idle" });
    expect(value.order).toEqual([
      "sandboxes",
      "sources",
      "compose",
      "admission",
      "fresh.create",
      "fresh.settle",
      "admission",
    ]);
    expect(value.sandboxes.recoverOwned).toHaveBeenCalledOnce();
    expect(value.compose).toHaveBeenCalledOnce();
  });

  it("forwards a queued caller signal only when its admission begins", async () => {
    const pending = deferred<FreshAttemptSessionResult>();
    const queued = new AbortController();
    const value = harness({
      admissions: [ready(), { state: "idle" }],
      fresh: [pending],
    });

    const first = value.dispatcher.dispatchNext();
    const second = value.dispatcher.dispatchNext(queued.signal);
    await vi.waitFor(() => expect(value.freshSettle).toHaveBeenCalledOnce());
    queued.abort(new Error("process shutdown"));
    expect(value.prepareNext).toHaveBeenCalledTimes(1);

    pending.resolve(completedOwnership());
    await first;
    await second;
    expect(value.prepareNext.mock.calls[1]?.[0]).toBe(queued.signal);
    expect(value.createFresh.mock.calls[0]).toHaveLength(1);
  });

  it("passes one immutable startup result to composition", async () => {
    const value = harness();

    await value.dispatcher.dispatchNext();

    const startup = value.compose.mock.calls[0]?.[0];
    expect(startup).toEqual({ sandboxesRemoved: 2, sourcesRemoved: 3 });
    expect(Object.isFrozen(startup)).toBe(true);
  });

  it("shares one pending deferred composition across queued dispatches", async () => {
    const pending = deferred<StartupGatedAttemptComposition>();
    const value = harness({
      admissions: [{ state: "idle" }, { state: "idle" }],
      compose: async () => pending.promise,
    });

    const first = value.dispatcher.dispatchNext();
    const second = value.dispatcher.dispatchNext();
    await vi.waitFor(() => expect(value.compose).toHaveBeenCalledOnce());
    expect(value.prepareNext).not.toHaveBeenCalled();
    pending.resolve(value.composition);

    await expect(first).resolves.toEqual({ state: "idle" });
    await expect(second).resolves.toEqual({ state: "idle" });
    expect(value.compose).toHaveBeenCalledOnce();
    expect(value.prepareNext).toHaveBeenCalledTimes(2);
  });

  it("retains startup failure and prevents every later effect", async () => {
    const failure = new Error("private sandbox cleanup failure");
    const value = harness({
      sandboxRecovery: async () => Promise.reject(failure),
    });

    const first = await value.dispatcher.dispatchNext().catch((cause) => cause);
    const second = await value.dispatcher
      .dispatchNext()
      .catch((cause) => cause);

    expect(first).toMatchObject({ code: "sandbox_recovery_failed" });
    expect(second).toBe(first);
    expect(value.sandboxes.recoverOwned).toHaveBeenCalledOnce();
    expect(value.sources.recoverOwned).not.toHaveBeenCalled();
    expect(value.compose).not.toHaveBeenCalled();
    expect(value.prepareNext).not.toHaveBeenCalled();
  });

  it.each([
    [
      "source failure",
      {
        sourceRecovery: async () =>
          Promise.reject(new Error("private source cleanup failure")),
      },
      "source_recovery_failed",
    ],
    [
      "invalid sandbox count",
      { sandboxRecovery: async () => -1 },
      "invalid_result",
    ],
    [
      "invalid source count",
      { sourceRecovery: async () => Number.NaN },
      "invalid_result",
    ],
  ] as const)(
    "retains %s before composition",
    async (_label, options, code) => {
      const value = harness(options);

      const first = await value.dispatcher
        .dispatchNext()
        .catch((cause) => cause);
      const second = await value.dispatcher
        .dispatchNext()
        .catch((cause) => cause);

      expect(first).toMatchObject({ code });
      expect(second).toBe(first);
      expect(value.compose).not.toHaveBeenCalled();
      expect(value.prepareNext).not.toHaveBeenCalled();
    },
  );

  it("retains composition failure without repeating startup or compose", async () => {
    const failure = new Error("private journal open failure");
    const value = harness({
      compose: async () => Promise.reject(failure),
    });

    const first = await value.dispatcher.dispatchNext().catch((cause) => cause);
    const second = await value.dispatcher
      .dispatchNext()
      .catch((cause) => cause);

    expect(first).toBe(failure);
    expect(second).toBe(failure);
    expect(value.compose).toHaveBeenCalledOnce();
    expect(value.prepareNext).not.toHaveBeenCalled();
  });

  it.each([
    ["admission", { admissions: [new Error("admission failed")] }],
    [
      "fresh settle",
      { admissions: [ready()], fresh: [new Error("fresh failed")] },
    ],
    [
      "restart settle",
      {
        admissions: [recoveryPending()],
        restart: [new Error("restart failed")],
      },
    ],
  ] as const)("poisons after %s rejection", async (_label, options) => {
    const value = harness(options as Parameters<typeof harness>[0]);

    const first = await value.dispatcher.dispatchNext().catch((cause) => cause);
    const effects = [...value.order];
    const second = await value.dispatcher
      .dispatchNext()
      .catch((cause) => cause);

    expect(second).toBe(first);
    expect(value.order).toEqual(effects);
  });

  it("poisons when a session factory throws synchronously", async () => {
    const failure = new Error("private factory failure");
    const value = harness({ admissions: [ready()] });
    value.composition.createFresh = vi.fn(() => {
      throw failure;
    });

    const first = await value.dispatcher.dispatchNext().catch((cause) => cause);
    const second = await value.dispatcher
      .dispatchNext()
      .catch((cause) => cause);

    expect(first).toBe(failure);
    expect(second).toBe(failure);
    expect(value.prepareNext).toHaveBeenCalledOnce();
  });

  it.each([
    null,
    { state: "unknown" },
    { state: "idle", extra: true },
    { ...ready(), extra: true },
    { ...recoveryPending(), recovered: false },
    {
      state: "completed",
      execution,
      work: { ...completedWork(), completion: { acknowledgedSequence: 2 } },
      recovered: true,
    },
  ])("fails closed for malformed admission %#", async (candidate) => {
    const value = harness({
      admissions: [candidate as WorkAdmissionResult],
    });

    const first = await value.dispatcher.dispatchNext().catch((cause) => cause);
    const second = await value.dispatcher
      .dispatchNext()
      .catch((cause) => cause);

    expect(first).toMatchObject({
      name: "StartupGatedAttemptDispatcherError",
      code: "invalid_admission",
      message: "Startup-gated work admission result is invalid.",
    });
    expect(second).toBe(first);
    expect(value.createFresh).not.toHaveBeenCalled();
    expect(value.createRestartRecovery).not.toHaveBeenCalled();
  });

  it.each([
    { state: "completed" },
    { ...noEvidence(), reason: "invented" },
    {
      ...noEvidence(),
      authority: { state: "released", reason: "terminal_publication_failed" },
    },
    {
      ...completedOwnership(),
      authority: { state: "released", reason: "terminal_evidence_unavailable" },
    },
    {
      ...completedOwnership(),
      publication: {
        ...completedOwnership().publication,
        work: { ...completedWork(), extra: true },
      },
    },
  ])("fails closed for malformed fresh result %#", async (candidate) => {
    const value = harness({
      admissions: [ready()],
      fresh: [candidate as FreshAttemptSessionResult],
    });

    await expect(value.dispatcher.dispatchNext()).rejects.toMatchObject({
      name: "StartupGatedAttemptDispatcherError",
      code: "invalid_session_result",
      message: "Startup-gated session result is invalid.",
    });
  });

  it("rejects cancellation authority drift in a session result", async () => {
    const value = harness({
      admissions: [ready()],
      fresh: [
        {
          state: "no_evidence",
          reason: "observation_conflict",
          authority: {
            state: "cancelled",
            cancellation: {
              version: "1",
              runnerId: execution.lease.runnerId,
              taskId: execution.lease.taskId,
              attemptId: "50000000-0000-4000-8000-000000000005",
              fence: execution.lease.fence,
              requestedAt: "2026-08-01T00:00:04.000Z",
              gracePeriodMs: 10,
              reason: "operator",
            },
            termination: { state: "absent" },
          },
        } as FreshAttemptSessionResult,
      ],
    });

    await expect(value.dispatcher.dispatchNext()).rejects.toMatchObject({
      code: "invalid_session_result",
    });
  });

  it("fails closed for a malformed restart session result", async () => {
    const value = harness({
      admissions: [recoveryPending()],
      restart: [
        {
          ...completedOwnership(),
          publication: {
            ...completedOwnership().publication,
            publication: "invented",
          },
        } as TerminalPublicationOwnershipResult,
      ],
    });

    const first = await value.dispatcher.dispatchNext().catch((cause) => cause);
    const second = await value.dispatcher
      .dispatchNext()
      .catch((cause) => cause);

    expect(first).toMatchObject({
      name: "StartupGatedAttemptDispatcherError",
      code: "invalid_session_result",
    });
    expect(second).toBe(first);
    expect(value.createRestartRecovery).toHaveBeenCalledOnce();
  });

  it.each([
    null,
    {},
    { admission: { prepareNext: vi.fn() }, createFresh: vi.fn() },
    {
      admission: {},
      createFresh: vi.fn(),
      createRestartRecovery: vi.fn(),
    },
    {
      admission: { prepareNext: vi.fn() },
      createFresh: vi.fn(),
      createRestartRecovery: vi.fn(),
      extra: true,
    },
  ])("retains invalid deferred composition %#", async (composition) => {
    const value = harness({
      compose: async () => composition as StartupGatedAttemptComposition,
    });

    const first = await value.dispatcher.dispatchNext().catch((cause) => cause);
    const second = await value.dispatcher
      .dispatchNext()
      .catch((cause) => cause);

    expect(first).toBeInstanceOf(StartupGatedAttemptDispatcherError);
    expect(first).toMatchObject({ code: "invalid_composition" });
    expect(second).toBe(first);
    expect(value.compose).toHaveBeenCalledOnce();
  });

  it("captures composition methods before later dependency mutation", async () => {
    const admission = deferred<WorkAdmissionResult>();
    const value = harness({ admissions: [admission] });

    const running = value.dispatcher.dispatchNext();
    await vi.waitFor(() => expect(value.prepareNext).toHaveBeenCalledOnce());
    value.composition.createFresh = vi.fn(() => {
      throw new Error("mutated factory must not run");
    });
    value.composition.admission.prepareNext = vi.fn(async () => {
      throw new Error("mutated admission must not run");
    });
    admission.resolve(ready());

    await expect(running).resolves.toMatchObject({
      state: "settled",
      path: "fresh",
    });
    expect(value.createFresh).toHaveBeenCalledOnce();
  });
});
