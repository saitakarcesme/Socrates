import { runnerExecutionV1Schema } from "@socrates/contracts";
import { describe, expect, it } from "vitest";

import { attemptKeyFor } from "../spool/codec";
import type { WorkJournalState } from "./contracts";
import {
  TerminalEvidencePublicationDeferredError,
  TerminalEvidencePublicationError,
  TerminalEvidencePublicationStateUncertainError,
  type TerminalEvidencePublicationResult,
} from "./terminal-evidence-publication";
import {
  TerminalPublicationAuthorityPolicy,
  TerminalPublicationAuthorityPolicyError,
  type TerminalPublicationSettlement,
} from "./terminal-publication-authority-policy";
import type { TerminalPublicationDisposition } from "./terminal-publication-disposition";
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

function disposition(
  state: TerminalPublicationDisposition["state"],
): TerminalPublicationDisposition {
  if (state === "absent") return { state, work: work() };
  return {
    state,
    work: work(state === "completed" ? "completed" : "execution_started"),
    acknowledgedSequence: state === "pending" ? 0 : 2,
    lastSequence: 2,
    pendingEvents: state === "pending" ? 2 : 0,
  };
}

function deferred(
  state: TerminalPublicationDisposition["state"],
): TerminalEvidencePublicationDeferredError {
  return new TerminalEvidencePublicationDeferredError(
    "recovery_before_append",
    disposition(state),
    { cause: new Error("secret dependency failure") },
  );
}

const policy = new TerminalPublicationAuthorityPolicy();

describe("TerminalPublicationAuthorityPolicy", () => {
  it.each(["appended", "recovered"] as const)(
    "stops after %s durable completion without retaining work",
    (publication) => {
      const mutableWork = work("completed");
      const value: TerminalEvidencePublicationResult = {
        state: "completed",
        publication,
        work: mutableWork,
      };

      const result = policy.decide({ status: "fulfilled", value });
      Object.assign(mutableWork, { state: "retired" });

      expect(result).toEqual({ state: "stop" });
      expect(Object.isFrozen(result)).toBe(true);
      expect(result).not.toHaveProperty("work");
    },
  );

  it.each(["pending", "acknowledged"] as const)(
    "retains authority for deferred %s evidence",
    (state) => {
      const reason = deferred(state);
      const result = policy.decide({ status: "rejected", reason });

      expect(result).toEqual({ state: "retain" });
      expect(Object.isFrozen(result)).toBe(true);
      expect(result).not.toHaveProperty("reason");
      expect(result).not.toHaveProperty("disposition");
    },
  );

  it("abandons deferred absent publication", () => {
    expect(
      policy.decide({ status: "rejected", reason: deferred("absent") }),
    ).toEqual({ state: "abandon" });
  });

  it("fails closed for malformed deferred disposition", () => {
    const reason = new TerminalEvidencePublicationDeferredError(
      "append",
      null as unknown as TerminalPublicationDisposition,
    );
    expect(policy.decide({ status: "rejected", reason })).toEqual({
      state: "abandon",
    });
  });

  it("rejects deferred completion as impossible", () => {
    expect(() =>
      policy.decide({
        status: "rejected",
        reason: deferred("completed"),
      }),
    ).toThrow(
      expect.objectContaining<Partial<TerminalPublicationAuthorityPolicyError>>(
        {
          code: "impossible_disposition",
        },
      ),
    );
  });

  it.each([
    new TerminalEvidencePublicationStateUncertainError("append", {
      cause: new Error("secret audit failure"),
    }),
    new TerminalEvidencePublicationError("completed_evidence_missing", "fatal"),
    new TerminalEvidencePublicationError("identity_conflict", "fatal"),
    new TerminalEvidencePublicationError("invalid_input", "fatal"),
    new TerminalEvidencePublicationError(
      "publication_not_recoverable",
      "fatal",
    ),
    new TerminalEvidencePublicationError("work_not_publishable", "fatal"),
    new Error("unknown secret failure"),
    "non-error rejection",
  ])("abandons fatal or unknown rejection %#", (reason) => {
    const result = policy.decide({ status: "rejected", reason });
    expect(result).toEqual({ state: "abandon" });
    expect(Object.isFrozen(result)).toBe(true);
    expect(JSON.stringify(result)).toBe('{"state":"abandon"}');
  });

  it.each([
    null,
    {},
    { status: "unknown" },
    { status: "fulfilled", value: null },
    { status: "fulfilled", value: { state: "completed" } },
    {
      status: "fulfilled",
      value: { state: "completed", publication: "invalid", work: work() },
    },
  ])("rejects malformed settlement %#", (candidate) => {
    expect(() =>
      policy.decide(candidate as unknown as TerminalPublicationSettlement),
    ).toThrow(
      expect.objectContaining<Partial<TerminalPublicationAuthorityPolicyError>>(
        {
          code: "invalid_input",
        },
      ),
    );
  });
});
