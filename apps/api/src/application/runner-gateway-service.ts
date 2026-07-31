import { maximumRunnerTaskOfferDurationMs } from "@socrates/database";
import type {
  AcquireRunnerTaskDeliveryInput,
  ClaimRunnerTaskInput,
  ClaimRunnerTaskDeliveryInput,
  ClaimedRunnerTask,
  HeartbeatRunnerTaskInput,
  IngestRunnerEventInput,
  Persistence,
  RunnerEventAcknowledgement,
} from "@socrates/database";

import {
  budgetExhausted,
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
  readonly #offerDurationMs: number;

  constructor(
    private readonly persistence: RunnerGatewayPersistence,
    options: { offerDurationMs?: number } = {},
  ) {
    const duration = options.offerDurationMs ?? 2 * 60 * 1_000;
    if (
      !Number.isSafeInteger(duration) ||
      duration <= 0 ||
      duration > maximumRunnerTaskOfferDurationMs
    ) {
      throw new RangeError(
        `Runner offer duration must be between 1 and ${maximumRunnerTaskOfferDurationMs} ms.`,
      );
    }
    this.#offerDurationMs = duration;
  }

  async acquireTaskDelivery(
    input: Pick<AcquireRunnerTaskDeliveryInput, "runnerId">,
  ): Promise<{ deliveryId: string; taskId: string } | null> {
    const result = await this.persistence.transaction(({ scheduler }) =>
      scheduler.acquireTaskDelivery({
        ...input,
        offerDurationMs: this.#offerDurationMs,
      }),
    );
    if (result.state === "acquired") return result.delivery;
    if (result.state === "none" || result.state === "runner_at_capacity") {
      return null;
    }
    if (result.state === "runner_not_found") {
      return notFound("runner registration", { runnerReason: result.state });
    }
    return runnerConflict(
      result.state,
      "The runner registration is not active.",
    );
  }

  async claimTaskDelivery(
    input: ClaimRunnerTaskDeliveryInput,
  ): Promise<ClaimedRunnerTask> {
    const result = await this.persistence.transaction(({ scheduler }) =>
      scheduler.claimTaskDelivery(input),
    );
    if (result.state === "claimed") return result.claim;
    if (result.state === "delivery_not_found") {
      return notFound("runner task delivery", { runnerReason: result.state });
    }
    if (result.state === "delivery_conflict") {
      return runnerConflict(
        result.state,
        "The task delivery conflicts with the claim identity.",
      );
    }
    return this.#claimFailure(result.state);
  }

  async claimTask(input: ClaimRunnerTaskInput): Promise<ClaimedRunnerTask> {
    const result = await this.persistence.transaction(({ scheduler }) =>
      scheduler.claimTask(input),
    );
    if (result.state === "claimed") return result.claim;

    return this.#claimFailure(result.state);
  }

  #claimFailure(
    state:
      | "runner_not_found"
      | "runner_unavailable"
      | "runner_at_capacity"
      | "attempt_conflict"
      | "task_not_found"
      | "task_unavailable"
      | "capability_mismatch",
  ): never {
    switch (state) {
      case "runner_not_found":
        return notFound("runner registration", {
          runnerReason: state,
        });
      case "task_not_found":
        return notFound("runner task", { runnerReason: state });
      case "attempt_conflict":
        return runnerConflict(
          state,
          "The attempt ID already identifies different runner work.",
        );
      case "runner_unavailable":
        return runnerConflict(state, "The runner registration is not active.");
      case "runner_at_capacity":
        return runnerConflict(
          state,
          "The runner has no available task capacity.",
        );
      case "task_unavailable":
        return runnerConflict(
          state,
          "The task cannot be claimed in its current state.",
        );
      case "capability_mismatch":
        return runnerConflict(
          state,
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
      case "budget_exhausted":
        return budgetExhausted(
          "The runner evidence would exceed its frozen byte budget.",
          {
            runnerReason: result.state,
            dimension: result.dimension,
            limitBytes: result.limitBytes,
            acceptedBytes: result.acceptedBytes,
            attemptedBytes: result.attemptedBytes,
          },
        );
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

  async heartbeat(input: HeartbeatRunnerTaskInput): Promise<{
    leaseExpiresAt: Date;
    directive: "continue" | "cancel";
  }> {
    const result = await this.persistence.transaction(({ scheduler }) =>
      scheduler.heartbeat(input),
    );
    if (result.state === "renewed") {
      return {
        leaseExpiresAt: result.leaseExpiresAt,
        directive: result.directive,
      };
    }

    return runnerConflict(
      result.state,
      "The runner task lease or fence is stale.",
    );
  }
}
