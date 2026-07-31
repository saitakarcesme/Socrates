import type { RunnerTaskDeliveryV1 } from "@socrates/contracts";

import type { WorkJournalState } from "../work-journal/contracts";
import type { RunnerControlPlaneClient } from "./client";

export interface TaskDeliveryJournal {
  admit(delivery: RunnerTaskDeliveryV1): Promise<WorkJournalState>;
}

export interface TaskDeliveryClient {
  acquireTaskDelivery(
    signal?: AbortSignal,
  ): Promise<RunnerTaskDeliveryV1 | null>;
}

export class JournaledTaskSource {
  readonly #client: TaskDeliveryClient;
  readonly #journal: TaskDeliveryJournal;

  constructor(options: {
    client: Pick<RunnerControlPlaneClient, "acquireTaskDelivery">;
    journal: TaskDeliveryJournal;
  }) {
    this.#client = options.client;
    this.#journal = options.journal;
  }

  async acquire(signal?: AbortSignal): Promise<WorkJournalState | null> {
    const delivery = await this.#client.acquireTaskDelivery(signal);
    if (!delivery) return null;
    return this.#journal.admit(delivery);
  }
}
