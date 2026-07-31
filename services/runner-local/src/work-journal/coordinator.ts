import type {
  RunnerExecutionV1,
  RunnerTaskDeliveryV1,
} from "@socrates/contracts";

import {
  RunnerTransportError,
  type RunnerControlPlaneClient,
} from "../transport/client";
import { WorkJournalError, type WorkJournalState } from "./contracts";
import { ExactClaimReconciler } from "./reconciler";
import { LocalWorkJournal } from "./store";

export type WorkAdmissionResult =
  | Readonly<{ state: "idle" }>
  | Readonly<{
      state: "ready";
      execution: RunnerExecutionV1;
      recovered: boolean;
    }>
  | Readonly<{
      state: "rejected";
      work: WorkJournalState;
      recovered: boolean;
    }>;

function deliveryFor(state: WorkJournalState): RunnerTaskDeliveryV1 {
  return {
    version: "1",
    deliveryId: state.deliveryId,
    taskId: state.taskId,
  };
}

function ordered(states: readonly WorkJournalState[]): WorkJournalState[] {
  return [...states].sort(
    (left, right) =>
      left.admittedAt.localeCompare(right.admittedAt) ||
      left.deliveryId.localeCompare(right.deliveryId),
  );
}

export class WorkAdmissionCoordinator {
  readonly #journal: LocalWorkJournal;
  readonly #client: RunnerControlPlaneClient;
  readonly #claims: ExactClaimReconciler;
  #operationTail: Promise<void> = Promise.resolve();

  constructor(options: {
    journal: LocalWorkJournal;
    client: RunnerControlPlaneClient;
    leaseDurationMs: number;
  }) {
    this.#journal = options.journal;
    this.#client = options.client;
    this.#claims = new ExactClaimReconciler(options);
  }

  async prepareNext(signal?: AbortSignal): Promise<WorkAdmissionResult> {
    return this.#serialize(async () => {
      const local = ordered(await this.#journal.list());
      const actionable = local.find((work) => work.state !== "rejected");
      if (actionable) return this.#prepare(actionable, true, signal);

      const delivery = await this.#client.acquireTaskDelivery(signal);
      if (!delivery) return Object.freeze({ state: "idle" });
      const admitted = await this.#journal.admit(delivery);
      return this.#prepare(admitted, false, signal);
    });
  }

  async #prepare(
    work: WorkJournalState,
    recovered: boolean,
    signal?: AbortSignal,
  ): Promise<WorkAdmissionResult> {
    if (work.state === "rejected") {
      return Object.freeze({ state: "rejected", work, recovered });
    }
    if (work.state === "claimed") {
      const execution = await this.#journal.claimedExecution(work.deliveryId);
      if (!execution) {
        throw new WorkJournalError(
          "corrupt",
          "Claimed journal state has no durable execution.",
        );
      }
      return Object.freeze({ state: "ready", execution, recovered });
    }

    try {
      const execution = await this.#claims.reconcile(deliveryFor(work), signal);
      return Object.freeze({ state: "ready", execution, recovered });
    } catch (error) {
      if (
        error instanceof RunnerTransportError &&
        error.code === "conflict" &&
        error.response?.status === 409
      ) {
        const rejected = await this.#journal.commitRejection(work.deliveryId, {
          status: 409,
          apiCode: error.response.apiCode,
          requestId: error.response.requestId,
        });
        return Object.freeze({ state: "rejected", work: rejected, recovered });
      }
      throw error;
    }
  }

  async #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#operationTail;
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#operationTail = previous.then(() => current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
