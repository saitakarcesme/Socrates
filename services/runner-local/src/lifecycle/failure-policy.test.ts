import { randomUUID } from "node:crypto";

import {
  runnerBudgetDimensionSchema,
  runnerEventV2Schema,
} from "@socrates/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  localFailureEvidence,
  type LocalFailureAmbiguityBoundary,
  type LocalFailureCode,
} from "./failure-policy";

const failureCodes = [
  "projection_rejected",
  "source_unavailable",
  "source_invalid",
  "image_rejected",
  "source_materialization_failed",
  "request_materialization_failed",
  "sandbox_backend_failed",
  "runtime_protocol_invalid",
  "cleanup_failed",
  "unexpected_runner_failure",
] as const satisfies readonly LocalFailureCode[];

const ambiguityBoundaries = [
  "transport",
  "event_rejection",
  "spool",
  "acknowledgement",
  "work_journal",
  "completion",
] as const satisfies readonly LocalFailureAmbiguityBoundary[];

function validateDraft(draft: unknown): void {
  runnerEventV2Schema.parse({
    version: "2",
    eventId: randomUUID(),
    runnerId: randomUUID(),
    taskId: randomUUID(),
    attemptId: randomUUID(),
    fence: 1,
    sequence: 1,
    occurredAt: "2026-07-31T12:00:00.000Z",
    ...(draft as object),
  });
}

describe("local failure evidence policy", () => {
  it.each(failureCodes)(
    "maps %s to one fixed frozen terminal draft",
    (code) => {
      const first = localFailureEvidence({
        kind: "failure",
        code,
        executionStarted: false,
      });
      const second = localFailureEvidence({
        kind: "failure",
        code,
        executionStarted: true,
      });

      expect(first).toEqual(second);
      expect(first.state).toBe("evidence");
      if (first.state !== "evidence") throw new Error("Expected evidence.");
      expect(first.draft.type).toBe("task.failed");
      expect(Object.isFrozen(first)).toBe(true);
      expect(Object.isFrozen(first.draft)).toBe(true);
      expect(Object.isFrozen(first.draft.payload)).toBe(true);
      validateDraft(first.draft);
    },
  );

  it.each(runnerBudgetDimensionSchema.options)(
    "binds the exact %s budget dimension",
    (dimension) => {
      const decision = localFailureEvidence({
        kind: "budget",
        dimension,
        executionStarted: true,
      });
      expect(decision).toMatchObject({
        state: "evidence",
        draft: {
          type: "task.failed",
          payload: { classification: "budget", budgetDimension: dimension },
        },
      });
      if (decision.state === "evidence") validateDraft(decision.draft);
    },
  );

  it("requires a strict cancellation directive and drops its reason", () => {
    const directive = {
      version: "1" as const,
      runnerId: randomUUID(),
      taskId: randomUUID(),
      attemptId: randomUUID(),
      fence: 1,
      requestedAt: "2026-07-31T12:00:00.000Z",
      gracePeriodMs: 2_500,
      reason: "operator" as const,
    };
    const decision = localFailureEvidence({
      kind: "cancellation",
      directive,
      executionStarted: true,
      elapsedMs: 123,
      forced: true,
    });
    expect(decision).toEqual({
      state: "evidence",
      draft: {
        type: "task.cancelled",
        payload: { forced: true, durationMs: 123 },
      },
    });
    expect(JSON.stringify(decision)).not.toContain("operator");
    expect(() =>
      localFailureEvidence({
        kind: "cancellation",
        directive: { ...directive, reason: "forged" },
        executionStarted: false,
        elapsedMs: 0,
        forced: false,
      } as never),
    ).toThrow();
  });

  it.each(ambiguityBoundaries)(
    "emits no competing evidence for %s ambiguity",
    (boundary) => {
      expect(
        localFailureEvidence({
          kind: "ambiguous",
          boundary,
          executionStarted: true,
        }),
      ).toEqual({ state: "no_evidence", boundary });
    },
  );

  it("rejects duration, unknown code, and arbitrary cause content", () => {
    for (const elapsedMs of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        localFailureEvidence({
          kind: "cancellation",
          directive: {},
          executionStarted: false,
          elapsedMs,
          forced: false,
        } as never),
      ).toThrow();
    }
    const secret = "C:/private/token=srt1.secret";
    expect(() =>
      localFailureEvidence({
        kind: "failure",
        code: "unexpected_runner_failure",
        executionStarted: false,
        cause: new Error(secret),
      } as never),
    ).toThrow();
    expect(() =>
      localFailureEvidence({
        kind: "failure",
        code: "unknown",
        executionStarted: false,
      } as never),
    ).toThrow();
  });

  it("rejects arbitrary exception text and keeps evidence immutable", () => {
    fc.assert(
      fc.property(fc.string(), (secret) => {
        expect(() =>
          localFailureEvidence({
            kind: "failure",
            code: "unexpected_runner_failure",
            executionStarted: true,
            cause: new Error(secret),
          } as never),
        ).toThrow();
      }),
    );

    const decision = localFailureEvidence({
      kind: "failure",
      code: "unexpected_runner_failure",
      executionStarted: true,
    });
    if (decision.state !== "evidence") throw new Error("Expected evidence.");
    expect(() => {
      (decision.draft.payload as { message?: string }).message = "mutated";
    }).toThrow(TypeError);
  });
});
