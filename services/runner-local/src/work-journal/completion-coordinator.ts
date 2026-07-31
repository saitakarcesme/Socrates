import type { RunnerExecutionV1 } from "@socrates/contracts";

import { attemptKeyFor, type SpoolState } from "../spool/index";
import { WorkJournalError, type WorkJournalState } from "./contracts";
import { LocalWorkJournal } from "./store";

export interface TerminalAcknowledgementSpool {
  inspect(execution: RunnerExecutionV1): Promise<SpoolState>;
}

export type WorkCompletionResult =
  | Readonly<{
      state: "not_ready";
      reason: "terminal_acknowledgement_missing";
    }>
  | Readonly<{ state: "completed"; work: WorkJournalState; replay: boolean }>;

export class WorkCompletionCoordinator {
  #operationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly journal: LocalWorkJournal,
    private readonly spool: TerminalAcknowledgementSpool,
  ) {}

  complete(deliveryId: string): Promise<WorkCompletionResult> {
    return this.#serialize(async () => {
      const work = await this.journal.inspect(deliveryId);
      if (!work) {
        throw new WorkJournalError(
          "identity_conflict",
          "Completion delivery is not present in the work journal.",
        );
      }
      if (work.state === "completed") {
        return Object.freeze({ state: "completed", work, replay: true });
      }
      if (work.state !== "claimed" && work.state !== "execution_started") {
        throw new WorkJournalError(
          "identity_conflict",
          "Only active claimed or started work can become completed.",
        );
      }
      const execution = await this.journal.claimedExecution(deliveryId);
      if (!execution) {
        throw new WorkJournalError(
          "corrupt",
          "Claimed work has no durable execution.",
        );
      }
      const spool = await this.spool.inspect(execution);
      const expectedAttemptKey = attemptKeyFor(execution);
      if (spool.attemptKey !== expectedAttemptKey) {
        throw new WorkJournalError(
          "identity_conflict",
          "Terminal acknowledgement belongs to another attempt.",
        );
      }
      if (
        !spool.terminal ||
        spool.pendingEvents !== 0 ||
        spool.lastSequence < 1 ||
        spool.acknowledgedSequence !== spool.lastSequence
      ) {
        return Object.freeze({
          state: "not_ready",
          reason: "terminal_acknowledgement_missing",
        });
      }
      const completed = await this.journal.commitCompletion(
        deliveryId,
        execution,
        {
          attemptKey: expectedAttemptKey,
          acknowledgedSequence: spool.acknowledgedSequence,
        },
      );
      return Object.freeze({
        state: "completed",
        work: completed,
        replay: false,
      });
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
