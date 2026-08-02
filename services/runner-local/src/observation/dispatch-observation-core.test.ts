import { canonicalJson } from "@socrates/runtime-protocol";
import { describe, expect, it, vi } from "vitest";

import type { StartupGatedAttemptDispatchResult } from "../session";
import {
  NodeLocalRunnerDispatchObservationError,
  type NodeLocalRunnerDispatchObservationErrorCode,
} from "./dispatch-observation-contracts";
import {
  createDispatchObservationCore,
  encodeDispatchObservationRecord,
  projectDispatchObservation,
  type DispatchObservationByteSink,
} from "./dispatch-observation-core";

const decoder = new TextDecoder();
const schema = "socrates.local-runner.dispatch-observation.v1";
const deliveryId = "40000000-0000-4000-8000-000000000004";
const runnerId = "10000000-0000-4000-8000-000000000001";
const taskId = "30000000-0000-4000-8000-000000000003";
const attemptId = "20000000-0000-4000-8000-000000000002";

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

function execution(secret = "private-task-payload") {
  return deepFreeze({
    version: "1",
    lease: { runnerId, taskId, attemptId, fence: 4 },
    task: { secret },
  });
}

function activeWork() {
  return {
    deliveryId,
    taskId,
    attemptId,
    state: "execution_started",
    admittedAt: "2026-08-02T00:00:00.000Z",
    claimedAt: "2026-08-02T00:00:01.000Z",
    executionStartedAt: "2026-08-02T00:00:02.000Z",
  };
}

function result(candidate: unknown): StartupGatedAttemptDispatchResult {
  return deepFreeze(candidate) as StartupGatedAttemptDispatchResult;
}

function settledCompleted(
  path: "fresh" | "restart_recovery" = "fresh",
  authority = "stopped",
  publication = "appended",
) {
  return result({
    state: "settled",
    path,
    deliveryId,
    execution: execution(),
    result: {
      state: "completed",
      publication: {
        state: "completed",
        publication,
        work: {
          ...activeWork(),
          privateEvidence: "private-terminal-evidence",
        },
      },
      authority: {
        state: authority,
        privateCancellation: "private-cancellation",
      },
    },
  });
}

function settledNoEvidence(
  authority = "released",
  reason = "observation_uncertain",
) {
  return result({
    state: "settled",
    path: "fresh",
    deliveryId,
    execution: execution(),
    result: {
      state: "no_evidence",
      reason,
      authority: {
        state: authority,
        privateTermination: "private-termination",
      },
    },
  });
}

const observations = [
  {
    name: "idle",
    result: result({ state: "idle" }),
    expected: { schema, state: "idle" },
  },
  {
    name: "rejected",
    result: result({
      state: "rejected",
      recovered: false,
      work: {
        ...activeWork(),
        state: "rejected",
        rejection: {
          reason: "control_plane_conflict",
          status: 409,
          apiCode: "resource_conflict",
          requestId: "private-unbounded-request-id",
        },
      },
    }),
    expected: {
      schema,
      state: "rejected",
      deliveryId,
      taskId,
      attemptId,
      recovered: false,
      reason: "control_plane_conflict",
      status: 409,
      apiCode: "resource_conflict",
    },
  },
  {
    name: "indeterminate",
    result: result({
      state: "indeterminate",
      execution: execution(),
      work: activeWork(),
      recovered: true,
      observedAt: "2026-08-02T00:00:04.000Z",
      leaseExpiresAt: "2026-08-02T00:00:30.000Z",
    }),
    expected: {
      schema,
      state: "indeterminate",
      deliveryId,
      runnerId,
      taskId,
      attemptId,
      fence: 4,
      recovered: true,
      observedAt: "2026-08-02T00:00:04.000Z",
      leaseExpiresAt: "2026-08-02T00:00:30.000Z",
    },
  },
  {
    name: "retired",
    result: result({
      state: "retired",
      execution: execution(),
      recovered: true,
      work: {
        ...activeWork(),
        state: "retired",
        retirement: { reason: "lease_expired_requeued" },
      },
    }),
    expected: {
      schema,
      state: "retired",
      deliveryId,
      runnerId,
      taskId,
      attemptId,
      fence: 4,
      recovered: true,
      reason: "lease_expired_requeued",
    },
  },
  {
    name: "completed",
    result: result({
      state: "completed",
      execution: execution(),
      recovered: true,
      work: {
        ...activeWork(),
        state: "completed",
        completion: {
          acknowledgedSequence: 2,
          attemptKey: "private-attempt-key",
        },
      },
    }),
    expected: {
      schema,
      state: "completed",
      deliveryId,
      runnerId,
      taskId,
      attemptId,
      fence: 4,
      recovered: true,
      acknowledgedSequence: 2,
    },
  },
  {
    name: "fresh completed settlement",
    result: settledCompleted(),
    expected: {
      schema,
      state: "settled",
      deliveryId,
      runnerId,
      taskId,
      attemptId,
      fence: 4,
      path: "fresh",
      result: "completed",
      publication: "appended",
      authority: "stopped",
    },
  },
  {
    name: "restart completed settlement",
    result: settledCompleted("restart_recovery", "stale", "recovered"),
    expected: {
      schema,
      state: "settled",
      deliveryId,
      runnerId,
      taskId,
      attemptId,
      fence: 4,
      path: "restart_recovery",
      result: "completed",
      publication: "recovered",
      authority: "stale",
    },
  },
  {
    name: "fresh no-evidence settlement",
    result: settledNoEvidence(),
    expected: {
      schema,
      state: "settled",
      deliveryId,
      runnerId,
      taskId,
      attemptId,
      fence: 4,
      path: "fresh",
      result: "no_evidence",
      reason: "observation_uncertain",
      authority: "released",
    },
  },
] as const;

async function expectCode(
  operation: Promise<unknown>,
  code: NodeLocalRunnerDispatchObservationErrorCode,
) {
  const error = await operation.catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(NodeLocalRunnerDispatchObservationError);
  expect(error).toMatchObject({ code });
  expect(Object.isFrozen(error)).toBe(true);
  expect("cause" in (error as object)).toBe(false);
  expect(JSON.stringify(error)).not.toMatch(/private|payload|credential/u);
  expect((error as Error).message).not.toMatch(/private|payload|credential/u);
}

describe("dispatch observation projection", () => {
  it.each(observations)("projects exact canonical $name bytes", (value) => {
    const bytes = projectDispatchObservation(value.result);
    expect(decoder.decode(bytes)).toBe(`${canonicalJson(value.expected)}\n`);
    expect(bytes.byteLength).toBeLessThanOrEqual(2_048);
    expect(bytes.at(-1)).toBe(0x0a);
    expect(decoder.decode(bytes.slice(0, -1))).not.toContain("\n");
  });

  it.each(["cancelled", "stale", "stopped"])(
    "admits completed authority state %s without its payload",
    (authority) => {
      const line = decoder.decode(
        projectDispatchObservation(settledCompleted("fresh", authority)),
      );
      expect(JSON.parse(line)).toMatchObject({ authority });
      expect(line).not.toContain("private-cancellation");
    },
  );

  it.each(["cancelled", "released", "stale"])(
    "admits no-evidence authority state %s without its payload",
    (authority) => {
      const line = decoder.decode(
        projectDispatchObservation(settledNoEvidence(authority)),
      );
      expect(JSON.parse(line)).toMatchObject({ authority });
      expect(line).not.toContain("private-termination");
    },
  );

  it("excludes every non-allowlisted payload sentinel", () => {
    for (const value of observations) {
      expect(
        decoder.decode(projectDispatchObservation(value.result)),
      ).not.toMatch(
        /private-|task-payload|request-id|attempt-key|terminal-evidence/u,
      );
    }
  });

  it("enforces the encoded byte ceiling", () => {
    expect(() =>
      encodeDispatchObservationRecord({ private: "x".repeat(2_049) }),
    ).toThrowError(
      expect.objectContaining({
        code: "projection_failed",
      }),
    );
  });

  it.each([
    ["mutable result", { state: "idle" }],
    ["unknown state", result({ state: "private-state" })],
    [
      "invalid lease identity",
      result({
        state: "completed",
        execution: {
          lease: { runnerId: "private", taskId, attemptId, fence: 4 },
        },
        recovered: true,
        work: {
          ...activeWork(),
          completion: { acknowledgedSequence: 1 },
        },
      }),
    ],
    [
      "inconsistent work identity",
      result({
        state: "completed",
        execution: execution(),
        recovered: true,
        work: {
          ...activeWork(),
          taskId: "50000000-0000-4000-8000-000000000005",
          completion: { acknowledgedSequence: 1 },
        },
      }),
    ],
    [
      "invalid timestamp",
      result({
        state: "indeterminate",
        execution: execution(),
        work: activeWork(),
        recovered: true,
        observedAt: "private-time",
        leaseExpiresAt: "2026-08-02T00:00:30.000Z",
      }),
    ],
    [
      "invalid no-evidence path",
      result({
        ...settledNoEvidence(),
        path: "restart_recovery",
      }),
    ],
    ["invalid completed authority", settledCompleted("fresh", "released")],
    ["invalid no-evidence authority", settledNoEvidence("stopped")],
  ] as const)("rejects %s before sink access", async (_name, candidate) => {
    const write = vi.fn<DispatchObservationByteSink["write"]>(async () =>
      Promise.resolve(),
    );
    const observer = createDispatchObservationCore({ write });
    await expectCode(
      observer.observe(candidate as StartupGatedAttemptDispatchResult),
      "projection_failed",
    );
    expect(write).not.toHaveBeenCalled();
  });

  it("rejects proxy and frozen accessor results before sink access", async () => {
    const write = vi.fn<DispatchObservationByteSink["write"]>(async () =>
      Promise.resolve(),
    );
    const observer = createDispatchObservationCore({ write });
    const accessor = Object.freeze(
      Object.defineProperty({}, "state", {
        enumerable: true,
        get() {
          throw new Error("private accessor payload");
        },
      }),
    );
    await expectCode(
      observer.observe(new Proxy(result({ state: "idle" }), {})),
      "projection_failed",
    );
    await expectCode(
      observer.observe(accessor as StartupGatedAttemptDispatchResult),
      "projection_failed",
    );
    expect(write).not.toHaveBeenCalled();
  });
});

describe("dispatch observation sink", () => {
  it("issues one write and settles only after that write settles", async () => {
    let settle: (() => void) | undefined;
    const sinkSettlement = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const write = vi.fn(async () => sinkSettlement);
    const observer = createDispatchObservationCore({ write });
    let observed = false;
    const operation = observer.observe(result({ state: "idle" })).then(() => {
      observed = true;
    });

    await Promise.resolve();
    expect(write).toHaveBeenCalledTimes(1);
    expect(observed).toBe(false);
    expect(write.mock.calls[0]![0]).toBeInstanceOf(Uint8Array);
    settle?.();
    await operation;
    expect(observed).toBe(true);
  });

  it.each(["throw", "reject"] as const)(
    "normalizes a sink %s without its cause",
    async (failure) => {
      const write = () => {
        const error = new Error("private sink credential payload");
        if (failure === "throw") throw error;
        return Promise.reject(error);
      };
      const observer = createDispatchObservationCore({ write });
      await expectCode(
        observer.observe(result({ state: "idle" })),
        "write_failed",
      );
    },
  );
});
