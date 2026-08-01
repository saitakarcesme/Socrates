import { runnerExecutionV1Schema } from "@socrates/contracts";
import { describe, expect, it } from "vitest";

import { runnerEventDraft } from "./draft";
import {
  TerminalOutcomeArbiter,
  TerminalOutcomeArbiterError,
  type TerminalAuthorityObservation,
  type TerminalOutcomeCandidate,
} from "./outcome-arbiter";
import taskFixture from "../../../../packages/contracts/fixtures/runner/task-v2.json";

const execution = runnerExecutionV1Schema.parse({
  version: "1",
  lease: {
    version: "1",
    runnerId: "10000000-0000-4000-8000-000000000001",
    taskId: taskFixture.taskId,
    attemptId: "20000000-0000-4000-8000-000000000002",
    fence: 3,
    leasedUntil: "2026-08-01T18:00:00.000Z",
  },
  task: taskFixture,
});

const cancellation = Object.freeze({
  version: "1" as const,
  runnerId: execution.lease.runnerId,
  taskId: execution.lease.taskId,
  attemptId: execution.lease.attemptId,
  fence: execution.lease.fence,
  requestedAt: "2026-08-01T17:59:59.000Z",
  gracePeriodMs: 2_500,
  reason: "operator" as const,
});

function runtimeCandidate(): TerminalOutcomeCandidate {
  return {
    state: "runtime",
    drafts: [
      runnerEventDraft({
        type: "action.started",
        payload: { commandIndex: 0 },
      }),
      runnerEventDraft({
        type: "task.succeeded",
        payload: { exitCode: 0, durationMs: 120 },
      }),
    ],
  };
}

function failureCandidate(): TerminalOutcomeCandidate {
  return {
    state: "failure",
    draft: runnerEventDraft({
      type: "task.failed",
      payload: {
        classification: "infrastructure",
        message: "Fixed runner failure.",
      },
    }),
  };
}

const authorities = {
  renewed: Object.freeze({
    state: "renewed" as const,
    leaseExpiresAt: "2026-08-01T18:00:30.000Z",
  }),
  stale: Object.freeze({ state: "stale" as const }),
  uncertain: Object.freeze({
    state: "uncertain" as const,
    boundary: "heartbeat" as const,
  }),
  absent: Object.freeze({
    state: "cancelled" as const,
    cancellation,
    termination: Object.freeze({ state: "absent" as const }),
  }),
  graceful: Object.freeze({
    state: "cancelled" as const,
    cancellation,
    termination: Object.freeze({
      state: "terminated" as const,
      forced: false,
    }),
  }),
  forced: Object.freeze({
    state: "cancelled" as const,
    cancellation,
    termination: Object.freeze({
      state: "terminated" as const,
      forced: true,
    }),
  }),
} satisfies Record<string, TerminalAuthorityObservation>;

type Expected =
  | { state: "evidence"; terminal: string; forced?: boolean }
  | { state: "no_evidence"; reason: string };

function summarize(
  decision: ReturnType<TerminalOutcomeArbiter["decide"]>,
): Expected {
  if (decision.state === "no_evidence") return decision;
  const terminal = decision.drafts.at(-1);
  if (!terminal) throw new Error("Expected terminal evidence.");
  return {
    state: "evidence",
    terminal: terminal.type,
    ...(terminal.type === "task.cancelled"
      ? { forced: terminal.payload.forced }
      : {}),
  };
}

describe("TerminalOutcomeArbiter", () => {
  it.each([
    [runtimeCandidate(), authorities.renewed, "task.succeeded", undefined],
    [runtimeCandidate(), authorities.absent, "task.succeeded", undefined],
    [runtimeCandidate(), authorities.graceful, "task.cancelled", false],
    [runtimeCandidate(), authorities.forced, "task.cancelled", true],
    [failureCandidate(), authorities.renewed, "task.failed", undefined],
    [failureCandidate(), authorities.absent, "task.cancelled", false],
    [failureCandidate(), authorities.graceful, "task.cancelled", false],
    [failureCandidate(), authorities.forced, "task.cancelled", true],
    [{ state: "none" }, authorities.absent, "task.cancelled", false],
    [{ state: "none" }, authorities.graceful, "task.cancelled", false],
    [{ state: "none" }, authorities.forced, "task.cancelled", true],
  ] as const)(
    "applies candidate %# and authority precedence",
    (candidate, authority, terminal, forced) => {
      const decision = new TerminalOutcomeArbiter(execution).decide({
        timing: { state: "started", elapsedMs: 123 },
        candidate,
        authority,
      });
      expect(summarize(decision)).toEqual({
        state: "evidence",
        terminal,
        ...(forced === undefined ? {} : { forced }),
      });
      if (decision.state === "evidence") {
        const last = decision.drafts.at(-1);
        if (last?.type === "task.cancelled") {
          expect(last.payload.durationMs).toBe(123);
          expect(JSON.stringify(last)).not.toContain("operator");
        }
      }
    },
  );

  it.each([
    [runtimeCandidate(), authorities.stale, "authority_lost"],
    [failureCandidate(), authorities.stale, "authority_lost"],
    [{ state: "none" }, authorities.stale, "authority_lost"],
    [runtimeCandidate(), authorities.uncertain, "authority_uncertain"],
    [failureCandidate(), authorities.uncertain, "authority_uncertain"],
    [{ state: "none" }, authorities.uncertain, "authority_uncertain"],
    [{ state: "none" }, authorities.renewed, "candidate_missing"],
  ] as const)(
    "suppresses candidate %# under closed authority outcome",
    (candidate, authority, reason) => {
      expect(
        new TerminalOutcomeArbiter(execution).decide({
          timing: { state: "started", elapsedMs: 123 },
          candidate,
          authority,
        }),
      ).toEqual({ state: "no_evidence", reason });
    },
  );

  it("emits exact pre-start cancellation only for an absent sandbox", () => {
    const arbiter = new TerminalOutcomeArbiter(execution);
    const absent = arbiter.decide({
      timing: { state: "not_started" },
      candidate: { state: "none" },
      authority: authorities.absent,
    });
    const terminated = arbiter.decide({
      timing: { state: "not_started" },
      candidate: { state: "none" },
      authority: authorities.forced,
    });

    expect(absent).toMatchObject({
      state: "evidence",
      drafts: [
        {
          type: "task.cancelled",
          payload: { forced: false, durationMs: 0 },
        },
      ],
    });
    expect(terminated).toEqual({
      state: "no_evidence",
      reason: "observation_conflict",
    });
  });

  it("rejects runtime evidence before the durable start latch", () => {
    expect(
      new TerminalOutcomeArbiter(execution).decide({
        timing: { state: "not_started" },
        candidate: runtimeCandidate(),
        authority: authorities.renewed,
      }),
    ).toEqual({
      state: "no_evidence",
      reason: "observation_conflict",
    });
  });

  it.each(["heartbeat", "revocation", "scheduler"] as const)(
    "redacts %s authority uncertainty into one frozen decision",
    (boundary) => {
      const decision = new TerminalOutcomeArbiter(execution).decide({
        timing: { state: "started", elapsedMs: 1 },
        candidate: runtimeCandidate(),
        authority: { state: "uncertain", boundary },
      });
      expect(decision).toEqual({
        state: "no_evidence",
        reason: "authority_uncertain",
      });
      expect(Object.isFrozen(decision)).toBe(true);
    },
  );

  it.each([
    [runtimeCandidate(), authorities.renewed, "observation_uncertain"],
    [failureCandidate(), authorities.renewed, "observation_uncertain"],
    [{ state: "none" }, authorities.renewed, "observation_uncertain"],
    [runtimeCandidate(), authorities.absent, "observation_uncertain"],
    [failureCandidate(), authorities.graceful, "observation_uncertain"],
    [{ state: "none" }, authorities.forced, "observation_uncertain"],
    [runtimeCandidate(), authorities.stale, "authority_lost"],
    [runtimeCandidate(), authorities.uncertain, "authority_uncertain"],
  ] as const)(
    "suppresses candidate %# for closed uncertain timing and authority precedence",
    (candidate, authority, reason) => {
      const decision = new TerminalOutcomeArbiter(execution).decide({
        timing: { state: "uncertain", boundary: "monotonic_time" },
        candidate,
        authority,
      });
      expect(decision).toEqual({ state: "no_evidence", reason });
      expect(Object.isFrozen(decision)).toBe(true);
    },
  );

  it("validates cancellation identity before suppressing uncertain timing", () => {
    expect(() =>
      new TerminalOutcomeArbiter(execution).decide({
        timing: { state: "uncertain", boundary: "monotonic_time" },
        candidate: { state: "none" },
        authority: {
          ...authorities.absent,
          cancellation: {
            ...cancellation,
            attemptId: "90000000-0000-4000-8000-000000000009",
          },
        },
      }),
    ).toThrowError(
      expect.objectContaining<Partial<TerminalOutcomeArbiterError>>({
        code: "identity_mismatch",
      }),
    );
  });

  it("validates the complete candidate before suppressing uncertain timing", () => {
    expect(() =>
      new TerminalOutcomeArbiter(execution).decide({
        timing: { state: "uncertain", boundary: "monotonic_time" },
        candidate: {
          state: "runtime",
          drafts: [
            runnerEventDraft({
              type: "action.started",
              payload: { commandIndex: 0 },
            }),
          ],
        },
        authority: authorities.renewed,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<TerminalOutcomeArbiterError>>({
        code: "invalid_input",
        message: "Terminal outcome input is invalid.",
      }),
    );
  });

  it("accepts zero and maximum safe started cancellation durations", () => {
    const arbiter = new TerminalOutcomeArbiter(execution);
    for (const elapsedMs of [0, Number.MAX_SAFE_INTEGER]) {
      const decision = arbiter.decide({
        timing: { state: "started", elapsedMs },
        candidate: { state: "none" },
        authority: authorities.forced,
      });
      expect(decision).toMatchObject({
        state: "evidence",
        drafts: [
          {
            type: "task.cancelled",
            payload: { forced: true, durationMs: elapsedMs },
          },
        ],
      });
    }
  });

  it("binds authenticated cancellation to the exact execution identity", () => {
    expect(() =>
      new TerminalOutcomeArbiter(execution).decide({
        timing: { state: "started", elapsedMs: 1 },
        candidate: { state: "none" },
        authority: {
          ...authorities.absent,
          cancellation: {
            ...cancellation,
            fence: cancellation.fence + 1,
          },
        },
      }),
    ).toThrowError(
      expect.objectContaining<Partial<TerminalOutcomeArbiterError>>({
        code: "identity_mismatch",
      }),
    );
  });

  it.each([
    { extra: true },
    { timing: { state: "started", elapsedMs: -1 } },
    { timing: { state: "started", elapsedMs: 0.5 } },
    { timing: { state: "not_started", elapsedMs: 0 } },
    { timing: { state: "uncertain", boundary: "wall_clock" } },
    {
      timing: {
        state: "uncertain",
        boundary: "monotonic_time",
        cause: new Error("C:/secret/token"),
      },
    },
    { candidate: { state: "failure", draft: runtimeCandidate().drafts?.[1] } },
    {
      candidate: {
        state: "failure",
        draft: runnerEventDraft({
          type: "task.cancelled",
          payload: { forced: false, durationMs: 1 },
        }),
      },
    },
    {
      candidate: {
        state: "runtime",
        drafts: [
          runnerEventDraft({
            type: "action.started",
            payload: { commandIndex: 0 },
          }),
        ],
      },
    },
    {
      candidate: {
        state: "runtime",
        drafts: [
          runnerEventDraft({
            type: "task.failed",
            payload: {
              classification: "infrastructure",
              message: "First terminal.",
            },
          }),
          runnerEventDraft({
            type: "task.cancelled",
            payload: { forced: false, durationMs: 1 },
          }),
        ],
      },
    },
    {
      authority: {
        state: "uncertain",
        boundary: "heartbeat",
        cause: new Error("C:/secret/token"),
      },
    },
    {
      authority: {
        ...authorities.absent,
        termination: { state: "terminated" },
      },
    },
    { authority: { state: "stopped" } },
    {
      authority: {
        state: "renewed",
        leaseExpiresAt: "not-an-instant",
      },
    },
  ])("rejects malformed strict input %# without exposing it", (override) => {
    expect(() =>
      new TerminalOutcomeArbiter(execution).decide({
        timing: { state: "started", elapsedMs: 1 },
        candidate: failureCandidate(),
        authority: authorities.renewed,
        ...override,
      } as never),
    ).toThrowError(
      expect.objectContaining<Partial<TerminalOutcomeArbiterError>>({
        code: "invalid_input",
        message: "Terminal outcome input is invalid.",
      }),
    );
  });

  it("deeply freezes cloned input and every evidence decision", () => {
    const candidate = runtimeCandidate();
    const decision = new TerminalOutcomeArbiter(execution).decide({
      timing: { state: "started", elapsedMs: 123 },
      candidate,
      authority: authorities.absent,
    });
    if (decision.state !== "evidence") throw new Error("Expected evidence.");

    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.drafts)).toBe(true);
    expect(decision.drafts.every(Object.isFrozen)).toBe(true);
    expect(
      decision.drafts.every(({ payload }) => Object.isFrozen(payload)),
    ).toBe(true);
    expect(decision.drafts).not.toBe(
      candidate.state === "runtime" ? candidate.drafts : undefined,
    );
    expect(() => {
      (decision.drafts[0]!.payload as { commandIndex?: number }).commandIndex =
        9;
    }).toThrow(TypeError);
  });

  it("rejects invalid execution without exposing arbitrary input text", () => {
    expect(
      () =>
        new TerminalOutcomeArbiter({
          secret: "C:/private/token=srt1.secret",
        } as never),
    ).toThrowError(
      expect.objectContaining<Partial<TerminalOutcomeArbiterError>>({
        code: "invalid_input",
        message: "Terminal outcome execution is invalid.",
      }),
    );
  });
});
