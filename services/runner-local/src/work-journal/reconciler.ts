import {
  runnerTaskDeliveryV1Schema,
  runnerTaskClaimRequestV1Schema,
  type RunnerExecutionV1,
  type RunnerTaskDeliveryV1,
} from "@socrates/contracts";

import type { RunnerControlPlaneClient } from "../transport/client";
import { LocalWorkJournal } from "./store";

export class ExactClaimReconciler {
  readonly #journal: LocalWorkJournal;
  readonly #client: RunnerControlPlaneClient;
  readonly #leaseDurationMs: number;
  #operationTail: Promise<void> = Promise.resolve();

  constructor(options: {
    journal: LocalWorkJournal;
    client: RunnerControlPlaneClient;
    leaseDurationMs: number;
  }) {
    this.#journal = options.journal;
    this.#client = options.client;
    this.#leaseDurationMs =
      runnerTaskClaimRequestV1Schema.shape.leaseDurationMs.parse(
        options.leaseDurationMs,
      );
  }

  async reconcile(
    input: RunnerTaskDeliveryV1,
    signal?: AbortSignal,
  ): Promise<RunnerExecutionV1> {
    const delivery = runnerTaskDeliveryV1Schema.parse(input);
    return this.#serialize(async () => {
      const state = await this.#journal.admit(delivery);
      const stored = await this.#journal.claimedExecution(delivery.deliveryId);
      if (stored) return stored;
      const execution = await this.#client.claimTask(
        delivery.taskId,
        {
          version: "1",
          attemptId: state.attemptId,
          leaseDurationMs: this.#leaseDurationMs,
        },
        signal,
      );
      return this.#journal.commitClaim(delivery.deliveryId, execution);
    });
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
