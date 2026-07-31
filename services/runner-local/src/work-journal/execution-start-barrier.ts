import {
  runnerExecutionV1Schema,
  runnerTaskDeliveryV1Schema,
  type RunnerExecutionV1,
} from "@socrates/contracts";

import type { RuntimeExecutionStartBarrier } from "../runtime/executor";
import type { WorkJournalState } from "./contracts";

export interface ExecutionStartJournal {
  commitExecutionStart(
    deliveryId: string,
    execution: RunnerExecutionV1,
  ): Promise<WorkJournalState>;
}

export class DurableExecutionStartBarrierError extends Error {
  constructor(
    readonly code: "unexpected_state",
    message: string,
  ) {
    super(message);
    this.name = "DurableExecutionStartBarrierError";
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export class DurableExecutionStartBarrier implements RuntimeExecutionStartBarrier {
  readonly #journal: ExecutionStartJournal;
  readonly #deliveryId: string;
  readonly #execution: RunnerExecutionV1;
  #operation: Promise<void> | undefined;

  constructor(options: {
    journal: ExecutionStartJournal;
    deliveryId: string;
    execution: RunnerExecutionV1;
  }) {
    this.#journal = options.journal;
    this.#deliveryId = runnerTaskDeliveryV1Schema.shape.deliveryId.parse(
      options.deliveryId,
    );
    this.#execution = deepFreeze(
      runnerExecutionV1Schema.parse(options.execution),
    );
  }

  cross(): Promise<void> {
    this.#operation ??= this.#cross();
    return this.#operation;
  }

  async #cross(): Promise<void> {
    const state = await this.#journal.commitExecutionStart(
      this.#deliveryId,
      this.#execution,
    );
    if (state.state !== "execution_started") {
      throw new DurableExecutionStartBarrierError(
        "unexpected_state",
        "The execution-start journal operation returned an unexpected state.",
      );
    }
  }
}
