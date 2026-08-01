import {
  runnerCancellationV1Schema,
  runnerExecutionV1Schema,
} from "@socrates/contracts";
import { describe, expect, it, vi } from "vitest";

import type {
  LeaseAuthorityCheckpointResult,
  LeaseAuthorityResult,
} from "../supervision/lease-authority-monitor";
import { attemptKeyFor } from "../spool/codec";
import type { WorkJournalState } from "./contracts";
import {
  TerminalEvidencePublicationDeferredError,
  TerminalEvidencePublicationError,
  TerminalEvidencePublicationStateUncertainError,
  type TerminalEvidencePublicationResult,
} from "./terminal-evidence-publication";
import type { TerminalPublicationDisposition } from "./terminal-publication-disposition";
import {
  TerminalPublicationOwner,
  TerminalPublicationOwnerError,
} from "./terminal-publication-owner";
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
const cancellation = runnerCancellationV1Schema.parse({
  version: "1",
  runnerId: execution.lease.runnerId,
  taskId: execution.lease.taskId,
  attemptId: execution.lease.attemptId,
  fence: execution.lease.fence,
  requestedAt: "2026-08-01T00:00:04.000Z",
  gracePeriodMs: 100,
  reason: "operator",
});
const termination = Object.freeze({
  state: "terminated" as const,
  forced: true,
});

function work(
  state: WorkJournalState["state"] = "execution_started",
  overrides: Partial<WorkJournalState> = {},
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
    ...overrides,
  };
}

function completed(
  publication: TerminalEvidencePublicationResult["publication"] = "recovered",
): TerminalEvidencePublicationResult {
  return {
    state: "completed",
    publication,
    work: work("completed"),
  };
}

function disposition(
  state: TerminalPublicationDisposition["state"],
  overrides: Partial<
    Extract<
      TerminalPublicationDisposition,
      { state: "acknowledged" | "pending" }
    >
  > = {},
): TerminalPublicationDisposition {
  if (state === "absent") return { state, work: work() };
  if (state === "completed") {
    return {
      state,
      work: work("completed"),
      acknowledgedSequence: 2,
      lastSequence: 2,
      pendingEvents: 0,
    };
  }
  return {
    state,
    work: work(),
    acknowledgedSequence: state === "pending" ? 0 : 2,
    lastSequence: 2,
    pendingEvents: state === "pending" ? 2 : 0,
    ...overrides,
  };
}

function deferred(
  state: TerminalPublicationDisposition["state"],
  overrides?: Partial<
    Extract<
      TerminalPublicationDisposition,
      { state: "acknowledged" | "pending" }
    >
  >,
): TerminalEvidencePublicationDeferredError {
  return new TerminalEvidencePublicationDeferredError(
    "recovery_before_append",
    disposition(state, overrides),
    { cause: new Error("secret publication dependency") },
  );
}

const stopped = Object.freeze({ state: "stopped" as const });
const stale = Object.freeze({ state: "stale" as const });
const abandoned = Object.freeze({
  state: "abandoned" as const,
  reason: "terminal_publication_failed" as const,
});
const released = Object.freeze({
  state: "released" as const,
  reason: "terminal_evidence_unavailable" as const,
});
const cancelled = Object.freeze({
  state: "cancelled" as const,
  cancellation,
  termination,
});
const renewed = Object.freeze({
  state: "renewed" as const,
  leaseExpiresAt: "2026-08-01T00:01:00.000Z",
});

type OperationStep<T> =
  | Readonly<{ state: "resolve"; value: T }>
  | Readonly<{ state: "reject"; error: Error }>
  | Readonly<{ state: "throw"; error: Error }>;

function operation<T>(steps: readonly OperationStep<T>[]) {
  const remaining = [...steps];
  return vi.fn(() => {
    const step = remaining.shift();
    if (!step) throw new Error("Unexpected operation call.");
    if (step.state === "throw") throw step.error;
    if (step.state === "reject") return Promise.reject(step.error);
    return Promise.resolve(step.value);
  });
}

function resolves<T>(value: T): OperationStep<T> {
  return { state: "resolve", value };
}

function rejects<T>(error: Error): OperationStep<T> {
  return { state: "reject", error };
}

function throws<T>(error: Error): OperationStep<T> {
  return { state: "throw", error };
}

function fixture(options: {
  publications: readonly OperationStep<TerminalEvidencePublicationResult>[];
  checkpoints?: readonly OperationStep<LeaseAuthorityCheckpointResult>[];
  stops?: readonly OperationStep<LeaseAuthorityResult>[];
  abandonments?: readonly OperationStep<LeaseAuthorityResult>[];
  maximumRecoveryAttempts?: number;
}) {
  const publish = operation(options.publications);
  const checkpoint = operation(options.checkpoints ?? []);
  const stop = operation(options.stops ?? [resolves(stopped)]);
  const abandonPublication = operation(
    options.abandonments ?? [resolves(abandoned)],
  );
  return {
    abandonPublication,
    checkpoint,
    publish,
    stop,
    value: new TerminalPublicationOwner({
      authority: { abandonPublication, checkpoint, stop },
      maximumRecoveryAttempts: options.maximumRecoveryAttempts ?? 3,
      publish,
    }),
  };
}

async function failureOf(value: TerminalPublicationOwner): Promise<unknown> {
  return value.complete().catch((cause: unknown) => cause);
}

describe("TerminalPublicationOwner", () => {
  it.each([-1, 1.5, 101, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid recovery bound %s",
    (maximumRecoveryAttempts) => {
      expect(
        () =>
          new TerminalPublicationOwner({
            authority: {
              checkpoint: async () => renewed,
              stop: async () => stopped,
              abandonPublication: async () => abandoned,
            },
            maximumRecoveryAttempts,
            publish: async () => completed(),
          }),
      ).toThrow(RangeError);
    },
  );

  it("publishes once and returns immutable clean completion", async () => {
    const publication = completed("appended");
    const value = fixture({ publications: [resolves(publication)] });

    const result = await value.value.complete();
    Object.assign(publication.work, { state: "retired" });

    expect(result).toEqual({
      state: "completed",
      publication: completed("appended"),
      authority: stopped,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.publication.work)).toBe(true);
    expect(value.publish).toHaveBeenCalledOnce();
    expect(value.stop).toHaveBeenCalledOnce();
    expect(value.checkpoint).not.toHaveBeenCalled();
    expect(value.abandonPublication).not.toHaveBeenCalled();
  });

  it.each([cancelled, stale])(
    "preserves completed publication when clean release returns $state",
    async (authority) => {
      const value = fixture({
        publications: [resolves(completed())],
        stops: [resolves(authority)],
      });

      await expect(value.value.complete()).resolves.toMatchObject({
        state: "completed",
        authority,
      });
      expect(value.abandonPublication).not.toHaveBeenCalled();
    },
  );

  it("rejects abandonment that won before clean release", async () => {
    const value = fixture({
      publications: [resolves(completed())],
      stops: [resolves(abandoned)],
    });

    await expect(value.value.complete()).rejects.toMatchObject({
      code: "release_conflict",
      authority: abandoned,
      publication: completed(),
    });
  });

  it("fails closed for a malformed clean-release result", async () => {
    const invalid = { state: "invalid" } as unknown as LeaseAuthorityResult;
    const value = fixture({
      publications: [resolves(completed())],
      stops: [resolves(invalid)],
    });

    await expect(value.value.complete()).rejects.toMatchObject({
      code: "release_conflict",
      authority: { state: "invalid" },
      publication: completed(),
    });
  });

  it("does not treat evidence-free release as completed publication", async () => {
    const value = fixture({
      publications: [resolves(completed())],
      stops: [resolves(released)],
    });

    await expect(value.value.complete()).rejects.toMatchObject({
      code: "release_conflict",
      authority: released,
      publication: completed(),
    });
    expect(value.abandonPublication).not.toHaveBeenCalled();
  });

  it("retains proven completion when clean release rejects", async () => {
    const releaseFailure = new Error("secret release failure");
    const value = fixture({
      publications: [resolves(completed())],
      stops: [rejects(releaseFailure)],
    });

    const failure = await failureOf(value.value);
    expect(failure).toBeInstanceOf(TerminalPublicationOwnerError);
    expect(failure).toMatchObject({
      code: "completion_release_uncertain",
      publication: completed(),
      cause: releaseFailure,
    });
    expect(Object.isFrozen(failure)).toBe(true);
    expect((failure as Error).message).not.toContain(releaseFailure.message);
  });

  it("contains a synchronous clean-release throw", async () => {
    const releaseFailure = new Error("synchronous stop failure");
    const value = fixture({
      publications: [resolves(completed())],
      stops: [throws(releaseFailure)],
    });

    await expect(value.value.complete()).rejects.toMatchObject({
      code: "completion_release_uncertain",
      cause: releaseFailure,
      publication: completed(),
    });
  });

  it("recovers acknowledged evidence without a checkpoint", async () => {
    const value = fixture({
      publications: [rejects(deferred("acknowledged")), resolves(completed())],
      maximumRecoveryAttempts: 1,
    });

    await expect(value.value.complete()).resolves.toMatchObject({
      state: "completed",
    });
    expect(value.publish).toHaveBeenCalledTimes(2);
    expect(value.checkpoint).not.toHaveBeenCalled();
    expect(value.stop).toHaveBeenCalledOnce();
  });

  it("requires one renewed checkpoint before each pending retry", async () => {
    const first = deferred("pending");
    const second = deferred("pending", {
      acknowledgedSequence: 1,
      pendingEvents: 1,
    });
    const value = fixture({
      publications: [rejects(first), rejects(second), resolves(completed())],
      checkpoints: [resolves(renewed), resolves(renewed)],
      maximumRecoveryAttempts: 2,
    });

    await expect(value.value.complete()).resolves.toMatchObject({
      state: "completed",
    });
    expect(value.publish).toHaveBeenCalledTimes(3);
    expect(value.checkpoint).toHaveBeenCalledTimes(2);
  });

  it("allows pending evidence to become acknowledged before local completion", async () => {
    const value = fixture({
      publications: [
        rejects(deferred("pending")),
        rejects(deferred("acknowledged")),
        resolves(completed()),
      ],
      checkpoints: [resolves(renewed)],
      maximumRecoveryAttempts: 2,
    });

    await expect(value.value.complete()).resolves.toMatchObject({
      state: "completed",
    });
    expect(value.checkpoint).toHaveBeenCalledOnce();
    expect(value.publish).toHaveBeenCalledTimes(3);
  });

  it.each(["pending", "acknowledged"] as const)(
    "abandons deferred %s evidence when zero retries are configured",
    async (state) => {
      const reason = deferred(state);
      const value = fixture({
        publications: [rejects(reason)],
        maximumRecoveryAttempts: 0,
      });

      await expect(value.value.complete()).rejects.toMatchObject({
        code: "recovery_exhausted",
        cause: reason,
        disposition: disposition(state),
        authority: abandoned,
      });
      expect(value.publish).toHaveBeenCalledOnce();
      expect(value.checkpoint).not.toHaveBeenCalled();
      expect(value.abandonPublication).toHaveBeenCalledOnce();
    },
  );

  it("counts every later publication call as exactly one retry", async () => {
    const value = fixture({
      publications: [
        rejects(deferred("acknowledged")),
        rejects(deferred("acknowledged")),
      ],
      maximumRecoveryAttempts: 1,
    });

    await expect(value.value.complete()).rejects.toMatchObject({
      code: "recovery_exhausted",
    });
    expect(value.publish).toHaveBeenCalledTimes(2);
    expect(value.abandonPublication).toHaveBeenCalledOnce();
  });

  it("admits exactly one hundred configured recovery retries", async () => {
    const value = fixture({
      publications: [
        ...Array.from({ length: 100 }, () =>
          rejects<TerminalEvidencePublicationResult>(deferred("acknowledged")),
        ),
        resolves(completed()),
      ],
      maximumRecoveryAttempts: 100,
    });

    await expect(value.value.complete()).resolves.toMatchObject({
      state: "completed",
    });
    expect(value.publish).toHaveBeenCalledTimes(101);
    expect(value.checkpoint).not.toHaveBeenCalled();
  });

  it.each([cancelled, stale])(
    "ends pending recovery when checkpoint returns $state",
    async (checkpointResult) => {
      const reason = deferred("pending");
      const value = fixture({
        publications: [rejects(reason)],
        checkpoints: [resolves(checkpointResult)],
        maximumRecoveryAttempts: 1,
      });

      await expect(value.value.complete()).rejects.toMatchObject({
        code: "authority_checkpoint_terminal",
        cause: reason,
        authority: checkpointResult,
        disposition: reason.disposition,
      });
      expect(value.publish).toHaveBeenCalledOnce();
      expect(value.abandonPublication).not.toHaveBeenCalled();
      expect(value.stop).not.toHaveBeenCalled();
    },
  );

  it("retains publication and checkpoint causes when authority is uncertain", async () => {
    const reason = deferred("pending");
    const checkpointFailure = new Error("secret checkpoint failure");
    const value = fixture({
      publications: [rejects(reason)],
      checkpoints: [rejects(checkpointFailure)],
      maximumRecoveryAttempts: 1,
    });

    const failure = await failureOf(value.value);
    expect(failure).toMatchObject({ code: "authority_checkpoint_uncertain" });
    expect((failure as Error).cause).toBeInstanceOf(AggregateError);
    expect(((failure as Error).cause as AggregateError).errors).toEqual([
      reason,
      checkpointFailure,
    ]);
    expect((failure as Error).message).not.toContain(checkpointFailure.message);
    expect(value.abandonPublication).not.toHaveBeenCalled();
  });

  it("contains a synchronous checkpoint throw", async () => {
    const reason = deferred("pending");
    const checkpointFailure = new Error("synchronous checkpoint failure");
    const value = fixture({
      publications: [rejects(reason)],
      checkpoints: [throws(checkpointFailure)],
      maximumRecoveryAttempts: 1,
    });

    const failure = await failureOf(value.value);
    expect(failure).toMatchObject({ code: "authority_checkpoint_uncertain" });
    expect(((failure as Error).cause as AggregateError).errors).toEqual([
      reason,
      checkpointFailure,
    ]);
  });

  it("fails closed for a malformed checkpoint result", async () => {
    const reason = deferred("pending");
    const invalid = {
      state: "invalid",
    } as unknown as LeaseAuthorityCheckpointResult;
    const value = fixture({
      publications: [rejects(reason)],
      checkpoints: [resolves(invalid)],
      maximumRecoveryAttempts: 1,
    });

    const failure = await failureOf(value.value);
    expect(failure).toMatchObject({ code: "authority_checkpoint_uncertain" });
    expect((failure as Error).cause).toBeInstanceOf(AggregateError);
    expect(((failure as Error).cause as AggregateError).errors[0]).toBe(reason);
    expect(value.publish).toHaveBeenCalledOnce();
    expect(value.abandonPublication).not.toHaveBeenCalled();
  });

  it("fails closed when pending recovery observes evidence-free release", async () => {
    const reason = deferred("pending");
    const value = fixture({
      publications: [rejects(reason)],
      checkpoints: [
        resolves(released as unknown as LeaseAuthorityCheckpointResult),
      ],
      maximumRecoveryAttempts: 1,
    });

    const failure = await failureOf(value.value);
    expect(failure).toMatchObject({ code: "authority_checkpoint_uncertain" });
    expect((failure as Error).cause).toBeInstanceOf(AggregateError);
    expect(((failure as Error).cause as AggregateError).errors[0]).toBe(reason);
    expect(value.publish).toHaveBeenCalledOnce();
    expect(value.stop).not.toHaveBeenCalled();
    expect(value.abandonPublication).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "work identity",
      first: deferred("pending"),
      second: deferred("pending", {
        work: work("execution_started", {
          attemptId: "90000000-0000-4000-8000-000000000009",
        }),
      }),
    },
    {
      label: "last sequence",
      first: deferred("pending"),
      second: deferred("pending", {
        acknowledgedSequence: 1,
        lastSequence: 3,
        pendingEvents: 2,
      }),
    },
    {
      label: "acknowledgement cursor",
      first: deferred("pending", {
        acknowledgedSequence: 1,
        pendingEvents: 1,
      }),
      second: deferred("pending"),
    },
    {
      label: "acknowledged to pending",
      first: deferred("acknowledged"),
      second: deferred("pending"),
    },
  ])("abandons $label regression", async ({ first, second }) => {
    const value = fixture({
      publications: [rejects(first), rejects(second)],
      checkpoints:
        first.disposition.state === "pending" ? [resolves(renewed)] : [],
      maximumRecoveryAttempts: 2,
    });

    await expect(value.value.complete()).rejects.toMatchObject({
      code: "disposition_regressed",
      cause: second,
      disposition: second.disposition,
      authority: abandoned,
    });
    expect(value.publish).toHaveBeenCalledTimes(2);
    expect(value.abandonPublication).toHaveBeenCalledOnce();
  });

  it("pins retained disposition before awaiting its checkpoint", async () => {
    const firstDisposition = disposition("pending");
    const first = new TerminalEvidencePublicationDeferredError(
      "recovery_before_append",
      firstDisposition,
    );
    const second = deferred("pending", {
      acknowledgedSequence: 1,
      pendingEvents: 1,
    });
    let resolveCheckpoint!: (value: LeaseAuthorityCheckpointResult) => void;
    const checkpointWait = new Promise<LeaseAuthorityCheckpointResult>(
      (resolve) => {
        resolveCheckpoint = resolve;
      },
    );
    const publish = operation([
      rejects<TerminalEvidencePublicationResult>(first),
      rejects<TerminalEvidencePublicationResult>(second),
      resolves(completed()),
    ]);
    const checkpoint = vi
      .fn<() => Promise<LeaseAuthorityCheckpointResult>>()
      .mockImplementationOnce(() => checkpointWait)
      .mockResolvedValueOnce(renewed);
    const value = new TerminalPublicationOwner({
      authority: {
        checkpoint,
        stop: async () => stopped,
        abandonPublication: async () => abandoned,
      },
      maximumRecoveryAttempts: 2,
      publish,
    });

    const running = value.complete();
    await vi.waitFor(() => expect(checkpoint).toHaveBeenCalledOnce());
    Object.assign(firstDisposition.work, {
      attemptId: "90000000-0000-4000-8000-000000000009",
    });
    Object.assign(firstDisposition, {
      acknowledgedSequence: 2,
      pendingEvents: 0,
    });
    resolveCheckpoint(renewed);

    await expect(running).resolves.toMatchObject({ state: "completed" });
    expect(publish).toHaveBeenCalledTimes(3);
    expect(checkpoint).toHaveBeenCalledTimes(2);
  });

  it.each([
    deferred("absent"),
    new TerminalEvidencePublicationStateUncertainError("append"),
    new TerminalEvidencePublicationError("identity_conflict", "fatal"),
    new Error("unknown fatal publication"),
  ])("abandons fatal publication %#", async (reason) => {
    const value = fixture({ publications: [rejects(reason)] });

    const failure = await failureOf(value.value);
    expect(failure).toMatchObject({
      code: "publication_abandoned",
      cause: reason,
      authority: abandoned,
    });
    expect((failure as Error).message).not.toContain(reason.message);
    expect(value.checkpoint).not.toHaveBeenCalled();
    expect(value.stop).not.toHaveBeenCalled();
    expect(value.abandonPublication).toHaveBeenCalledOnce();
  });

  it("abandons a fatal retry after one pending checkpoint", async () => {
    const fatal = new Error("fatal retry");
    const value = fixture({
      publications: [rejects(deferred("pending")), rejects(fatal)],
      checkpoints: [resolves(renewed)],
      maximumRecoveryAttempts: 2,
    });

    await expect(value.value.complete()).rejects.toMatchObject({
      code: "publication_abandoned",
      cause: fatal,
    });
    expect(value.publish).toHaveBeenCalledTimes(2);
    expect(value.abandonPublication).toHaveBeenCalledOnce();
  });

  it.each([cancelled, stale])(
    "preserves $state that races publication abandonment",
    async (authority) => {
      const value = fixture({
        publications: [rejects(new Error("fatal publication"))],
        abandonments: [resolves(authority)],
      });

      await expect(value.value.complete()).rejects.toMatchObject({
        code: "authority_terminal",
        authority,
      });
    },
  );

  it("rejects clean stop that won before abandonment", async () => {
    const value = fixture({
      publications: [rejects(new Error("fatal publication"))],
      abandonments: [resolves(stopped)],
    });

    await expect(value.value.complete()).rejects.toMatchObject({
      code: "release_conflict",
      authority: stopped,
    });
  });

  it("fails closed for a malformed abandonment result", async () => {
    const invalid = { state: "invalid" } as unknown as LeaseAuthorityResult;
    const value = fixture({
      publications: [rejects(new Error("fatal publication"))],
      abandonments: [resolves(invalid)],
    });

    await expect(value.value.complete()).rejects.toMatchObject({
      code: "release_conflict",
      authority: { state: "invalid" },
    });
  });

  it("does not treat evidence-free release as publication abandonment", async () => {
    const publicationFailure = new Error("fatal publication");
    const value = fixture({
      publications: [rejects(publicationFailure)],
      abandonments: [resolves(released)],
    });

    await expect(value.value.complete()).rejects.toMatchObject({
      code: "release_conflict",
      authority: released,
      cause: publicationFailure,
    });
    expect(value.stop).not.toHaveBeenCalled();
  });

  it("retains both causes when abandonment rejects", async () => {
    const publicationFailure = new Error("secret publication failure");
    const releaseFailure = new Error("secret abandonment failure");
    const value = fixture({
      publications: [rejects(publicationFailure)],
      abandonments: [rejects(releaseFailure)],
    });

    const failure = await failureOf(value.value);
    expect(failure).toMatchObject({ code: "release_uncertain" });
    expect((failure as Error).cause).toBeInstanceOf(AggregateError);
    expect(((failure as Error).cause as AggregateError).errors).toEqual([
      publicationFailure,
      releaseFailure,
    ]);
    expect((failure as Error).message).not.toContain(
      publicationFailure.message,
    );
    expect((failure as Error).message).not.toContain(releaseFailure.message);
  });

  it("contains a synchronous abandonment throw", async () => {
    const publicationFailure = new Error("fatal publication");
    const releaseFailure = new Error("synchronous abandonment failure");
    const value = fixture({
      publications: [rejects(publicationFailure)],
      abandonments: [throws(releaseFailure)],
    });

    const failure = await failureOf(value.value);
    expect(failure).toMatchObject({ code: "release_uncertain" });
    expect(((failure as Error).cause as AggregateError).errors).toEqual([
      publicationFailure,
      releaseFailure,
    ]);
  });

  it("abandons an impossible deferred completion", async () => {
    const impossible = deferred("completed");
    const value = fixture({ publications: [rejects(impossible)] });

    const failure = await failureOf(value.value);
    expect(failure).toMatchObject({
      code: "publication_abandoned",
      authority: abandoned,
    });
    expect((failure as Error).cause).toBeInstanceOf(AggregateError);
    expect(((failure as Error).cause as AggregateError).errors[0]).toBe(
      impossible,
    );
  });

  it("copies deferred evidence before exposing owner failure", async () => {
    const source = disposition("absent");
    const reason = new TerminalEvidencePublicationDeferredError(
      "append",
      source,
    );
    const value = fixture({ publications: [rejects(reason)] });

    const failure = (await failureOf(
      value.value,
    )) as TerminalPublicationOwnerError;
    Object.assign(source.work, {
      attemptId: "90000000-0000-4000-8000-000000000009",
    });

    expect(failure.disposition?.work.attemptId).toBe(execution.lease.attemptId);
    expect(Object.isFrozen(failure.disposition)).toBe(true);
    expect(Object.isFrozen(failure.disposition?.work)).toBe(true);
  });

  it.each(["throw", "reject"] as const)(
    "contains a synchronous or asynchronous publication %s through abandonment",
    async (mode) => {
      const failure = new Error(`secret ${mode}`);
      const value = fixture({
        publications: [mode === "throw" ? throws(failure) : rejects(failure)],
      });

      await expect(value.value.complete()).rejects.toMatchObject({
        code: "publication_abandoned",
        cause: failure,
      });
      expect(value.abandonPublication).toHaveBeenCalledOnce();
    },
  );

  it("joins concurrent and later complete calls to one operation", async () => {
    let resolvePublication!: (value: TerminalEvidencePublicationResult) => void;
    const pending = new Promise<TerminalEvidencePublicationResult>(
      (resolve) => {
        resolvePublication = resolve;
      },
    );
    const publish = vi.fn(() => pending);
    const stop = vi.fn(async () => stopped);
    const authority = {
      checkpoint: vi.fn(async () => renewed),
      stop,
      abandonPublication: vi.fn(async () => abandoned),
    };
    const value = new TerminalPublicationOwner({
      authority,
      maximumRecoveryAttempts: 1,
      publish,
    });

    const first = value.complete();
    const duplicate = value.complete();
    expect(duplicate).toBe(first);
    resolvePublication(completed());
    await expect(first).resolves.toMatchObject({ state: "completed" });
    expect(value.complete()).toBe(first);
    expect(publish).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("replays the same rejected Promise without repeating abandonment", async () => {
    const value = fixture({
      publications: [rejects(new Error("fatal publication"))],
    });

    const first = value.value.complete();
    const duplicate = value.value.complete();
    expect(duplicate).toBe(first);
    await expect(first).rejects.toMatchObject({
      code: "publication_abandoned",
    });
    expect(value.value.complete()).toBe(first);
    expect(value.publish).toHaveBeenCalledOnce();
    expect(value.abandonPublication).toHaveBeenCalledOnce();
  });
});
