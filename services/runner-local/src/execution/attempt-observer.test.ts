import { runnerExecutionV1Schema } from "@socrates/contracts";
import {
  runtimeFrameSchema,
  type RuntimeFrame,
} from "@socrates/runtime-protocol";
import { describe, expect, it, vi } from "vitest";

import { issueAdmittedSandboxImage } from "../image/capability";
import { issueMaterializedSourceSnapshot } from "../source/capability";
import { RuntimeSandboxError } from "../runtime/executor";
import { SandboxBackendError } from "../oci/backend";
import {
  AttemptExecutionObserver,
  type AttemptExecutionObservation,
} from "./attempt-observer";
import {
  AttemptPreparationError,
  type PreparedExecutionAttempt,
} from "./preparation-coordinator";
import {
  ExecutionPlanProjectionError,
  ExecutionPlanProjector,
  type LocalExecutionPolicy,
} from "./projector";
import {
  DurableExecutionTimingBarrier,
  DurableExecutionTimingBarrierError,
} from "./timing-barrier";
import taskFixture from "../../../../packages/contracts/fixtures/runner/task-v2.json";

const mebibyte = 1_024 * 1_024;
const policy: LocalExecutionPolicy = {
  maximumWallTimeMs: 300_000,
  maximumMemoryBytes: 1_024 * mebibyte,
  maximumPids: 128,
  maximumWritableBytes: 1_024 * mebibyte,
  maximumRuntimeOutputBytes: 2 * mebibyte,
  maximumCommandCount: 3,
  temporaryBytes: 64 * mebibyte,
  sharedMemoryBytes: 64 * mebibyte,
  cpuQuotaPeriodMicros: 100_000,
  minimumCpuQuotaMicros: 1_000,
  maximumCpuQuotaMicros: 100_000,
};

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

function encoded(value: string): string {
  return Buffer.from(value).toString("base64");
}

function successfulFrames(): readonly RuntimeFrame[] {
  const measurement = '{"schema":"metric-value.v1","value":"1.25"}';
  return [
    { type: "command.started", phase: "action", commandIndex: 0 },
    {
      type: "command.exited",
      phase: "action",
      commandIndex: 0,
      exitCode: 0,
      signal: null,
      durationMs: 4,
    },
    { type: "command.started", phase: "measurement", commandIndex: 0 },
    {
      type: "command.exited",
      phase: "measurement",
      commandIndex: 0,
      exitCode: 0,
      signal: null,
      durationMs: 5,
    },
    {
      type: "measurement.result",
      sequence: 0,
      final: true,
      bytes: encoded(measurement),
    },
    { type: "runtime.completed", status: "succeeded" },
  ].map((frame) => runtimeFrameSchema.parse(frame));
}

function prepared(): PreparedExecutionAttempt {
  const identity = Object.freeze({
    runnerId: execution.lease.runnerId,
    taskId: execution.lease.taskId,
    attemptId: execution.lease.attemptId,
    fence: execution.lease.fence,
  });
  return Object.freeze({
    identity,
    plan: new ExecutionPlanProjector(policy).project(execution),
    image: issueAdmittedSandboxImage({
      reference: execution.task.environment.imageDigest,
      localName: "trusted@digest",
      digest: execution.task.environment.imageDigest,
      configurationDigest:
        "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      architecture: execution.task.environment.architecture,
      runtime: { executable: "/runtime", arguments: [] },
      profileProbe: { executable: "/probe", arguments: [] },
    }),
    source: issueMaterializedSourceSnapshot({
      path: "C:\\private\\source",
      deploymentId: "test",
      identity,
      digest: execution.task.source.digest,
      archiveBytes: 10,
      expandedBytes: 20,
      entryCount: 1,
    }),
  });
}

function timing(readings: number[] = [10, 13]) {
  return new DurableExecutionTimingBarrier({
    barrier: { cross: vi.fn(async () => undefined) },
    time: {
      now: vi.fn(() => {
        const reading = readings.shift();
        if (reading === undefined) throw new Error("missing time");
        return reading;
      }),
    },
  });
}

function harness(options?: {
  prepare?: () => Promise<PreparedExecutionAttempt>;
  release?: (value: PreparedExecutionAttempt) => Promise<void>;
  execute?: (
    input: Parameters<
      import("../runtime/executor").RuntimeSandboxExecutor["execute"]
    >[0],
  ) => Promise<import("../runtime/executor").RuntimeSandboxResult>;
  signal?: AbortSignal;
  timing?: DurableExecutionTimingBarrier;
}) {
  const owned = prepared();
  const preparation = {
    prepare: vi.fn(options?.prepare ?? (async () => owned)),
    release: vi.fn(options?.release ?? (async () => undefined)),
  };
  const runtime = {
    execute: vi.fn(
      options?.execute ??
        (async (input) => {
          await input.startBarrier.cross();
          return {
            status: "succeeded" as const,
            frames: successfulFrames(),
            durationMs: 2.5,
          };
        }),
    ),
  };
  const observer = new AttemptExecutionObserver({
    execution,
    preparation,
    runtime,
    timing: options?.timing ?? timing(),
    signal: options?.signal,
  });
  return { observer, owned, preparation, runtime };
}

function failurePayload(observation: AttemptExecutionObservation) {
  expect(observation.candidate.state).toBe("failure");
  if (observation.candidate.state !== "failure") throw new Error("expected");
  return observation.candidate.draft.payload;
}

describe("AttemptExecutionObserver", () => {
  it("single-flights prepare, durable start, runtime adaptation, and release", async () => {
    const value = harness();
    const left = value.observer.observe();
    const right = value.observer.observe();

    expect(right).toBe(left);
    const observation = await left;
    expect(await right).toBe(observation);
    expect(observation.timing).toEqual({ state: "started", elapsedMs: 3 });
    expect(observation.candidate.state).toBe("runtime");
    if (observation.candidate.state === "runtime") {
      expect(observation.candidate.drafts.at(-1)?.type).toBe("task.succeeded");
      expect(Object.isFrozen(observation.candidate.drafts)).toBe(true);
    }
    expect(value.preparation.prepare).toHaveBeenCalledOnce();
    expect(value.runtime.execute).toHaveBeenCalledOnce();
    expect(value.preparation.release).toHaveBeenCalledWith(value.owned);
    expect(Object.isFrozen(observation)).toBe(true);
    expect(Object.isFrozen(observation.timing)).toBe(true);
  });

  it("maps typed preparation stages into redacted local failures", async () => {
    const cases = [
      ["source_unavailable", "infrastructure"],
      ["invalid_artifact", "policy"],
      ["invalid_image", "infrastructure"],
      ["source_materialization_failed", "infrastructure"],
      ["cleanup_failed", "infrastructure"],
    ] as const;

    for (const [code, classification] of cases) {
      const value = harness({
        prepare: async () =>
          Promise.reject(new AttemptPreparationError(code, "secret detail")),
      });
      const observation = await value.observer.observe();
      expect(observation.timing).toEqual({ state: "not_started" });
      expect(failurePayload(observation)).toMatchObject({ classification });
      expect(JSON.stringify(observation)).not.toContain("secret detail");
      expect(value.preparation.release).not.toHaveBeenCalled();
    }
  });

  it("normalizes projection and raw backend boundary errors", async () => {
    const projection = harness({
      prepare: () => {
        throw new ExecutionPlanProjectionError(
          "policy_exceeded",
          "private policy detail",
        );
      },
    });
    expect(failurePayload(await projection.observer.observe())).toMatchObject({
      classification: "policy",
    });

    const backend = harness({
      execute: () => {
        throw new SandboxBackendError("engine", "private engine detail");
      },
    });
    expect(failurePayload(await backend.observer.observe())).toMatchObject({
      classification: "infrastructure",
    });

    const cleanup = harness({
      execute: () => {
        throw new SandboxBackendError("cleanup", "private cleanup detail");
      },
    });
    expect(failurePayload(await cleanup.observer.observe())).toEqual({
      classification: "infrastructure",
      message: "The runner could not prove complete attempt resource cleanup.",
    });
  });

  it("maps runtime stages without exposing dependency errors", async () => {
    const cases = [
      ["request_materialization_failed", "infrastructure"],
      ["sandbox_backend_failed", "infrastructure"],
      ["protocol", "infrastructure"],
      ["request_release_failed", "infrastructure"],
      ["cleanup_failed", "infrastructure"],
    ] as const;

    for (const [code, classification] of cases) {
      const value = harness({
        execute: async () =>
          Promise.reject(new RuntimeSandboxError(code, "secret detail")),
      });
      const observation = await value.observer.observe();
      expect(failurePayload(observation)).toMatchObject({ classification });
      expect(JSON.stringify(observation)).not.toContain("secret detail");
      expect(value.preparation.release).toHaveBeenCalledOnce();
    }
  });

  it("returns none only for an exact authority abort", async () => {
    const exact = new AbortController();
    const reason = new Error("lease revoked");
    exact.abort(reason);
    const cancelled = harness({
      signal: exact.signal,
      prepare: async () => Promise.reject(reason),
    });
    await expect(cancelled.observer.observe()).resolves.toEqual({
      timing: { state: "not_started" },
      candidate: { state: "none" },
    });

    const late = new AbortController();
    const unrelated = new Error("resolver failed first");
    late.abort(new Error("lease revoked"));
    const failed = harness({
      signal: late.signal,
      prepare: async () => Promise.reject(unrelated),
    });
    const observation = await failed.observer.observe();
    expect(observation.candidate.state).toBe("failure");

    const typed = harness({
      execute: () => {
        throw new RuntimeSandboxError("cancelled", "safe cancellation");
      },
    });
    expect((await typed.observer.observe()).candidate).toEqual({
      state: "none",
    });
  });

  it("closes durable-start uncertainty to no local candidate", async () => {
    const barrier = new DurableExecutionTimingBarrier({
      barrier: {
        cross: vi.fn(async () =>
          Promise.reject(new Error("journal uncertain")),
        ),
      },
      time: { now: vi.fn(() => 1) },
    });
    const value = harness({ timing: barrier });

    await expect(value.observer.observe()).resolves.toEqual({
      timing: { state: "not_started" },
      candidate: { state: "none" },
    });
    expect(value.preparation.release).toHaveBeenCalledOnce();
  });

  it("shares timing uncertainty and still releases the prepared source", async () => {
    const cause = new Error("clock unavailable");
    const barrier = new DurableExecutionTimingBarrier({
      barrier: { cross: vi.fn(async () => undefined) },
      time: {
        now: vi.fn(() => {
          throw cause;
        }),
      },
    });
    const value = harness({ timing: barrier });
    const left = value.observer.observe();
    const right = value.observer.observe();

    expect(right).toBe(left);
    await expect(left).rejects.toMatchObject({
      code: "timing_uncertain",
    });
    await expect(right).rejects.toBeInstanceOf(Error);
    expect(value.preparation.release).toHaveBeenCalledOnce();
  });

  it("preserves nested timing and start uncertainty through cleanup wrappers", async () => {
    const timingFailure = new DurableExecutionTimingBarrierError(
      "timing_uncertain",
      "private clock detail",
    );
    const uncertain = harness({
      execute: async () =>
        Promise.reject(
          new RuntimeSandboxError(
            "request_release_failed",
            "request cleanup failed",
            {
              cause: new AggregateError([
                timingFailure,
                new Error("private cleanup detail"),
              ]),
            },
          ),
        ),
    });
    await expect(uncertain.observer.observe()).rejects.toMatchObject({
      code: "timing_uncertain",
      cause: timingFailure,
    });

    const startFailure = new DurableExecutionTimingBarrierError(
      "start_uncertain",
      "private journal detail",
    );
    const notPublishable = harness({
      execute: async () =>
        Promise.reject(
          new RuntimeSandboxError(
            "request_release_failed",
            "request cleanup failed",
            { cause: new AggregateError([startFailure]) },
          ),
        ),
    });
    await expect(notPublishable.observer.observe()).resolves.toEqual({
      timing: { state: "not_started" },
      candidate: { state: "none" },
    });
  });

  it("lets cleanup uncertainty override successful runtime evidence", async () => {
    const value = harness({
      release: async () => Promise.reject(new Error("private source path")),
    });
    const observation = await value.observer.observe();

    expect(observation.timing.state).toBe("started");
    expect(failurePayload(observation)).toEqual({
      classification: "infrastructure",
      message: "The runner could not prove complete attempt resource cleanup.",
    });
    expect(JSON.stringify(observation)).not.toContain("private source path");
  });

  it("normalizes synchronous release throw and deeply freezes its result", async () => {
    const value = harness({
      release: () => {
        throw new Error("private synchronous release detail");
      },
    });
    const observation = await value.observer.observe();

    expect(failurePayload(observation)).toMatchObject({
      classification: "infrastructure",
    });
    expect(() =>
      Object.assign(observation.candidate, { state: "none" }),
    ).toThrow();
    if (observation.candidate.state === "failure") {
      expect(() =>
        Object.assign(observation.candidate.draft.payload, {
          message: "mutated",
        }),
      ).toThrow();
    }
  });

  it("rejects identity-drifted prepared work before runtime execution", async () => {
    const owned = prepared();
    const drifted = Object.freeze({
      ...owned,
      identity: Object.freeze({
        ...owned.identity,
        fence: owned.identity.fence + 1,
      }),
    });
    const value = harness({ prepare: async () => drifted });
    const observation = await value.observer.observe();

    expect(observation.timing).toEqual({ state: "not_started" });
    expect(failurePayload(observation)).toEqual({
      classification: "infrastructure",
      message: "The runner encountered an unexpected controlled failure.",
    });
    expect(value.runtime.execute).not.toHaveBeenCalled();
    expect(value.preparation.release).toHaveBeenCalledWith(drifted);
  });

  it("normalizes malformed lifecycle evidence and releases the source", async () => {
    const value = harness({
      execute: async (input) => {
        await input.startBarrier.cross();
        return {
          status: "succeeded",
          frames: [{ type: "runtime.completed", status: "succeeded" }],
          durationMs: 1,
        };
      },
    });
    const observation = await value.observer.observe();

    expect(failurePayload(observation)).toMatchObject({
      classification: "infrastructure",
    });
    expect(value.preparation.release).toHaveBeenCalledOnce();
  });

  it("copies execution identity before caller mutation", async () => {
    const mutable = structuredClone(execution);
    const value = harness();
    const observer = new AttemptExecutionObserver({
      execution: mutable,
      preparation: value.preparation,
      runtime: value.runtime,
      timing: timing(),
    });
    mutable.lease.fence = 99;

    const observation = await observer.observe();
    expect(observation.candidate.state).toBe("runtime");
  });
});
