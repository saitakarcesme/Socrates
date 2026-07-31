import {
  runnerExecutionV1Schema,
  runnerTaskDeliveryV1Schema,
  type RunnerExecutionV1,
} from "@socrates/contracts";

import { attemptKeyFor } from "../spool/codec";
import type { SpoolState } from "../spool/contracts";
import type { SendPendingEventResult } from "../transport/sender";
import type { WorkCompletionResult } from "./completion-coordinator";
import type { WorkJournalState } from "./contracts";

export interface ExistingTerminalSpool {
  inspectExisting(execution: RunnerExecutionV1): Promise<SpoolState | null>;
}

export interface PendingTerminalEventSender {
  sendNext(execution: RunnerExecutionV1): Promise<SendPendingEventResult>;
}

export interface TerminalWorkCompleter {
  complete(deliveryId: string): Promise<WorkCompletionResult>;
}

export type TerminalEvidenceRecoveryResult =
  | Readonly<{ state: "none" }>
  | Readonly<{ state: "completed"; work: WorkJournalState }>;

export class TerminalEvidenceRecoveryError extends Error {
  constructor(
    readonly code:
      | "completion_not_ready"
      | "invalid_spool_state"
      | "premature_idle"
      | "state_drift",
    message: string,
  ) {
    super(message);
    this.name = "TerminalEvidenceRecoveryError";
  }
}

function empty(state: SpoolState): boolean {
  return (
    !state.terminal &&
    state.acknowledgedSequence === 0 &&
    state.lastSequence === 0 &&
    state.pendingEvents === 0
  );
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function validateState(state: SpoolState, expectedAttemptKey: string): void {
  if (
    state.attemptKey !== expectedAttemptKey ||
    !Number.isSafeInteger(state.lastSequence) ||
    !Number.isSafeInteger(state.acknowledgedSequence) ||
    !Number.isSafeInteger(state.pendingEvents) ||
    state.lastSequence < 0 ||
    state.acknowledgedSequence < 0 ||
    state.pendingEvents < 0
  ) {
    throw new TerminalEvidenceRecoveryError(
      "invalid_spool_state",
      "Existing terminal evidence has invalid identity or counters.",
    );
  }
}

function validateTerminalState(
  state: SpoolState,
  expectedAttemptKey: string,
): void {
  validateState(state, expectedAttemptKey);
  if (
    !state.terminal ||
    state.lastSequence < 1 ||
    state.acknowledgedSequence < 0 ||
    state.acknowledgedSequence > state.lastSequence ||
    state.pendingEvents !== state.lastSequence - state.acknowledgedSequence
  ) {
    throw new TerminalEvidenceRecoveryError(
      "invalid_spool_state",
      "Existing terminal evidence has an invalid bounded state.",
    );
  }
}

export class TerminalEvidenceRecoveryCoordinator {
  #operationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly spool: ExistingTerminalSpool,
    private readonly sender: PendingTerminalEventSender,
    private readonly completion: TerminalWorkCompleter,
  ) {}

  recover(
    deliveryId: string,
    candidate: RunnerExecutionV1,
  ): Promise<TerminalEvidenceRecoveryResult> {
    const parsedDeliveryId =
      runnerTaskDeliveryV1Schema.shape.deliveryId.parse(deliveryId);
    const execution = deepFreeze(runnerExecutionV1Schema.parse(candidate));
    const expectedAttemptKey = attemptKeyFor(execution);
    return this.#serialize(async () => {
      const initial = await this.spool.inspectExisting(execution);
      if (!initial) {
        return Object.freeze({ state: "none" });
      }
      validateState(initial, expectedAttemptKey);
      if (empty(initial)) return Object.freeze({ state: "none" });
      validateTerminalState(initial, expectedAttemptKey);

      for (let sent = 0; sent < initial.pendingEvents; sent += 1) {
        const delivery = await this.sender.sendNext(execution);
        if (delivery.state === "idle") {
          throw new TerminalEvidenceRecoveryError(
            "premature_idle",
            "Terminal evidence sender became idle before the bounded drain completed.",
          );
        }
        const expectedSequence = initial.acknowledgedSequence + sent + 1;
        if (delivery.sequence !== expectedSequence) {
          throw new TerminalEvidenceRecoveryError(
            "state_drift",
            "Terminal evidence acknowledgement sequence drifted during recovery.",
          );
        }
      }

      const drained = await this.spool.inspectExisting(execution);
      if (drained) validateTerminalState(drained, expectedAttemptKey);
      if (
        !drained ||
        !drained.terminal ||
        drained.lastSequence !== initial.lastSequence ||
        drained.acknowledgedSequence !== initial.lastSequence ||
        drained.pendingEvents !== 0
      ) {
        throw new TerminalEvidenceRecoveryError(
          "state_drift",
          "Terminal evidence state drifted after the bounded drain.",
        );
      }

      const completion = await this.completion.complete(parsedDeliveryId);
      if (completion.state !== "completed") {
        throw new TerminalEvidenceRecoveryError(
          "completion_not_ready",
          "Terminal acknowledgement did not make work completion ready.",
        );
      }
      return Object.freeze({ state: "completed", work: completion.work });
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
