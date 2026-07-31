import {
  runnerCancellationV1Schema,
  runnerExecutionV1Schema,
  type RunnerCancellationV1,
  type RunnerExecutionV1,
} from "@socrates/contracts";

import type { SandboxAttemptIdentity } from "../oci/identity";
import type { RunnerCancellationTarget } from "./lease-supervisor";

export interface SandboxCancellationBackend {
  cancel(
    identity: SandboxAttemptIdentity,
    gracePeriodMs: number,
  ): Promise<boolean>;
}

export type SandboxLocalRevocation = Readonly<{
  reason: "lease_stale" | "lease_uncertain" | "scheduler_failure";
  gracePeriodMs: number;
}>;

export class SandboxCancellationScopeError extends Error {
  constructor(
    readonly code: "identity_mismatch" | "policy_conflict",
    message: string,
  ) {
    super(message);
    this.name = "SandboxCancellationScopeError";
  }
}

function identityOf(execution: RunnerExecutionV1): SandboxAttemptIdentity {
  return Object.freeze({
    runnerId: execution.lease.runnerId,
    taskId: execution.lease.taskId,
    attemptId: execution.lease.attemptId,
    fence: execution.lease.fence,
  });
}

function sameIdentity(
  command: RunnerCancellationV1,
  identity: SandboxAttemptIdentity,
): boolean {
  return (
    command.runnerId === identity.runnerId &&
    command.taskId === identity.taskId &&
    command.attemptId === identity.attemptId &&
    command.fence === identity.fence
  );
}

function sameCommand(
  left: RunnerCancellationV1,
  right: RunnerCancellationV1,
): boolean {
  return (
    sameIdentity(left, right) &&
    left.requestedAt === right.requestedAt &&
    left.gracePeriodMs === right.gracePeriodMs &&
    left.reason === right.reason
  );
}

function localRevocation(
  candidate: SandboxLocalRevocation,
): SandboxLocalRevocation {
  if (
    candidate.reason !== "lease_stale" &&
    candidate.reason !== "lease_uncertain" &&
    candidate.reason !== "scheduler_failure"
  ) {
    throw new RangeError("Local revocation reason is not supported.");
  }
  if (
    !Number.isSafeInteger(candidate.gracePeriodMs) ||
    candidate.gracePeriodMs < 0 ||
    candidate.gracePeriodMs > 60_000
  ) {
    throw new RangeError("Local revocation grace must be between 0 and 60000.");
  }
  return Object.freeze({ ...candidate });
}

function sameRevocation(
  left: SandboxLocalRevocation,
  right: SandboxLocalRevocation,
): boolean {
  return (
    left.reason === right.reason && left.gracePeriodMs === right.gracePeriodMs
  );
}

type Termination =
  | Readonly<{ kind: "cancellation"; command: RunnerCancellationV1 }>
  | Readonly<{ kind: "revocation"; revocation: SandboxLocalRevocation }>;

export class SandboxCancellationScope implements RunnerCancellationTarget {
  readonly #backend: SandboxCancellationBackend;
  readonly #identity: SandboxAttemptIdentity;
  readonly #controller = new AbortController();
  #termination: Termination | undefined;
  #operation: Promise<void> | undefined;

  constructor(
    candidate: RunnerExecutionV1,
    backend: SandboxCancellationBackend,
  ) {
    const execution = runnerExecutionV1Schema.parse(candidate);
    this.#identity = identityOf(execution);
    this.#backend = backend;
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  cancel(candidate: RunnerCancellationV1): Promise<void> {
    let command: RunnerCancellationV1;
    try {
      command = runnerCancellationV1Schema.parse(candidate);
    } catch (error) {
      return Promise.reject(error);
    }
    if (!sameIdentity(command, this.#identity)) {
      return Promise.reject(
        new SandboxCancellationScopeError(
          "identity_mismatch",
          "Cancellation identity does not match the frozen execution.",
        ),
      );
    }
    if (this.#termination) {
      if (
        this.#termination.kind !== "cancellation" ||
        !sameCommand(command, this.#termination.command)
      ) {
        return Promise.reject(
          new SandboxCancellationScopeError(
            "policy_conflict",
            "Cancellation policy conflicts with the first command.",
          ),
        );
      }
      return this.#operation!;
    }

    this.#termination = Object.freeze({
      kind: "cancellation",
      command: Object.freeze(command),
    });
    this.#controller.abort();
    this.#operation = (async () => {
      await this.#backend.cancel(this.#identity, command.gracePeriodMs);
    })();
    return this.#operation;
  }

  revoke(candidate: SandboxLocalRevocation): Promise<void> {
    let revocation: SandboxLocalRevocation;
    try {
      revocation = localRevocation(candidate);
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.#termination) {
      if (
        this.#termination.kind !== "revocation" ||
        !sameRevocation(revocation, this.#termination.revocation)
      ) {
        return Promise.reject(
          new SandboxCancellationScopeError(
            "policy_conflict",
            "Local revocation conflicts with the first termination policy.",
          ),
        );
      }
      return this.#operation!;
    }

    this.#termination = Object.freeze({ kind: "revocation", revocation });
    this.#controller.abort();
    this.#operation = (async () => {
      await this.#backend.cancel(this.#identity, revocation.gracePeriodMs);
    })();
    return this.#operation;
  }
}
