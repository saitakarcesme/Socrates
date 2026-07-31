import type {
  ClaimRunnerTaskInput,
  ClaimedRunnerTask,
  IngestRunnerEventInput,
  Persistence,
  RunnerEventAcknowledgement,
} from "@socrates/database";

import {
  invalidTransition,
  notFound,
  protocolMismatch,
  resourceConflict,
} from "./errors";

type RunnerGatewayPersistence = Pick<Persistence, "transaction">;

function runnerConflict(reason: string, message: string): never {
  resourceConflict(message, { runnerReason: reason });
}

export class RunnerGatewayService {
  constructor(private readonly persistence: RunnerGatewayPersistence) {}

  async claimTask(input: ClaimRunnerTaskInput): Promise<ClaimedRunnerTask> {
    const result = await this.persistence.transaction(({ scheduler }) =>
      scheduler.claimTask(input),
    );
    if (result.state === "claimed") return result.claim;

    switch (result.state) {
      case "runner_not_found":
        return notFound("runner registration", {
          runnerReason: result.state,
        });
      case "task_not_found":
        return notFound("runner task", { runnerReason: result.state });
      case "attempt_conflict":
        return runnerConflict(
          result.state,
          "The attempt ID already identifies different runner work.",
        );
      case "runner_unavailable":
        return runnerConflict(
          result.state,
          "The runner registration is not active.",
        );
      case "runner_at_capacity":
        return runnerConflict(
          result.state,
          "The runner has no available task capacity.",
        );
      case "task_unavailable":
        return runnerConflict(
          result.state,
          "The task cannot be claimed in its current state.",
        );
      case "capability_mismatch":
        return runnerConflict(
          result.state,
          "The runner does not satisfy the task capabilities.",
        );
    }
  }

  async ingestEvent(
    input: IngestRunnerEventInput,
  ): Promise<{ replay: boolean; acknowledgement: RunnerEventAcknowledgement }> {
    const result = await this.persistence.transaction(({ scheduler }) =>
      scheduler.ingestEvent(input),
    );
    if (result.state === "accepted" || result.state === "replay") {
      return {
        replay: result.state === "replay",
        acknowledgement: result.acknowledgement,
      };
    }

    switch (result.state) {
      case "gap":
        return resourceConflict("The runner event sequence contains a gap.", {
          runnerReason: result.state,
          expectedSequence: result.expectedSequence,
        });
      case "invalid_transition":
        return invalidTransition(
          "The runner event is invalid for the current task lifecycle.",
          { runnerReason: result.state },
        );
      case "invalid_evidence":
        return protocolMismatch(
          "The runner evidence does not match the immutable task.",
          { runnerReason: result.state },
        );
      case "unsupported_event":
        return protocolMismatch(
          "The runner event kind is not enabled by this deployment.",
          { runnerReason: result.state },
        );
      case "event_conflict":
        return runnerConflict(
          result.state,
          "The runner event identity conflicts with committed evidence.",
        );
      case "stale":
        return runnerConflict(
          result.state,
          "The runner event lease or fence is stale.",
        );
    }
  }
}
