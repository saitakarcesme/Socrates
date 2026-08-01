import {
  runnerTaskDeliveryV1Schema,
  type RunnerExecutionV1,
} from "@socrates/contracts";

import type { WorkJournalState } from "./contracts";
import {
  immutableEvidenceSnapshot,
  sameCompletedWork,
  terminalActiveWorkSnapshot,
  terminalCompletedWorkSnapshot,
  terminalDispositionSnapshot,
  terminalExecutionSnapshot,
  TerminalEvidenceConsistencyError,
} from "./terminal-evidence-consistency";
import {
  TerminalEvidencePublicationDeferredError,
  TerminalEvidencePublicationStateUncertainError,
  type TerminalEvidencePublicationResult,
} from "./terminal-evidence-publication";
import type { TerminalEvidenceRecoveryResult } from "./terminal-evidence-recovery";
import type { TerminalPublicationDisposition } from "./terminal-publication-disposition";

export interface RecoveryOnlyTerminalDispositionPort {
  audit(
    deliveryId: string,
    execution: RunnerExecutionV1,
  ): Promise<TerminalPublicationDisposition>;
}

export interface RecoveryOnlyTerminalRecoveryPort {
  recover(
    deliveryId: string,
    execution: RunnerExecutionV1,
  ): Promise<TerminalEvidenceRecoveryResult>;
}

export class RecoveryOnlyTerminalPublicationError extends Error {
  constructor(
    readonly code:
      | "invalid_input"
      | "recovery_evidence_missing"
      | "recovery_result_inconsistent",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RecoveryOnlyTerminalPublicationError";
    Object.freeze(this);
  }
}

function aggregate(primary: unknown | undefined, secondary: unknown): unknown {
  return primary === undefined
    ? secondary
    : new AggregateError([primary, secondary]);
}

export class RecoveryOnlyTerminalPublication {
  readonly #auditor: RecoveryOnlyTerminalDispositionPort;
  readonly #baseline: WorkJournalState;
  readonly #deliveryId: string;
  readonly #execution: RunnerExecutionV1;
  readonly #recovery: RecoveryOnlyTerminalRecoveryPort;
  #operationTail: Promise<void> = Promise.resolve();

  constructor(options: {
    work: WorkJournalState;
    deliveryId: string;
    execution: RunnerExecutionV1;
    auditor: RecoveryOnlyTerminalDispositionPort;
    recovery: RecoveryOnlyTerminalRecoveryPort;
  }) {
    try {
      this.#deliveryId = runnerTaskDeliveryV1Schema.shape.deliveryId.parse(
        options.deliveryId,
      );
      this.#execution = terminalExecutionSnapshot(options.execution);
      this.#baseline = terminalActiveWorkSnapshot(
        options.work,
        this.#execution,
      );
      if (this.#baseline.deliveryId !== this.#deliveryId) {
        throw new TerminalEvidenceConsistencyError("work_invalid");
      }
    } catch (cause) {
      throw new RecoveryOnlyTerminalPublicationError(
        "invalid_input",
        "Recovery-only terminal publication input is invalid.",
        { cause },
      );
    }
    this.#auditor = options.auditor;
    this.#recovery = options.recovery;
  }

  publish(): Promise<TerminalEvidencePublicationResult> {
    return this.#serialize(() => this.#publish());
  }

  async #publish(): Promise<TerminalEvidencePublicationResult> {
    const initial = await this.#audit();
    if (initial.state === "completed") return this.#completed(initial.work);
    if (initial.state === "absent") return this.#missing();

    let recovered: TerminalEvidenceRecoveryResult;
    try {
      recovered = immutableEvidenceSnapshot(
        await this.#recovery.recover(this.#deliveryId, this.#execution),
      );
    } catch (cause) {
      if (cause instanceof TerminalEvidenceConsistencyError) {
        return this.#inconsistent(cause);
      }
      return this.#afterFailure(cause);
    }

    if (!recovered || recovered.state !== "completed") {
      return this.#inconsistent(
        new TypeError("Recovery did not return completed work."),
      );
    }
    let recoveredWork: WorkJournalState;
    try {
      recoveredWork = terminalCompletedWorkSnapshot(
        recovered.work,
        this.#baseline,
        this.#execution,
        initial.lastSequence,
      );
    } catch (cause) {
      return this.#inconsistent(cause);
    }

    const final = await this.#audit();
    if (
      final.state !== "completed" ||
      !sameCompletedWork(recoveredWork, final.work)
    ) {
      return this.#inconsistent(
        new TypeError("Recovery completion contradicts durable evidence."),
      );
    }
    return this.#completed(final.work);
  }

  async #afterFailure(
    primary: unknown,
  ): Promise<TerminalEvidencePublicationResult> {
    const disposition = await this.#audit(primary);
    if (disposition.state === "completed") {
      return this.#completed(disposition.work);
    }
    if (
      disposition.state === "pending" ||
      disposition.state === "acknowledged"
    ) {
      throw new TerminalEvidencePublicationDeferredError(
        "recovery_only",
        disposition,
        { cause: primary },
      );
    }
    return this.#missing(primary);
  }

  async #audit(primary?: unknown): Promise<TerminalPublicationDisposition> {
    let candidate: TerminalPublicationDisposition;
    try {
      candidate = await this.#auditor.audit(this.#deliveryId, this.#execution);
      return terminalDispositionSnapshot(
        candidate,
        this.#baseline,
        this.#execution,
      );
    } catch (cause) {
      throw new TerminalEvidencePublicationStateUncertainError(
        "recovery_only",
        { cause: aggregate(primary, cause) },
      );
    }
  }

  #completed(work: WorkJournalState): TerminalEvidencePublicationResult {
    return immutableEvidenceSnapshot({
      state: "completed",
      publication: "recovered",
      work,
    });
  }

  #missing(primary?: unknown): never {
    throw new RecoveryOnlyTerminalPublicationError(
      "recovery_evidence_missing",
      "Recovery-only terminal evidence is absent.",
      primary === undefined ? undefined : { cause: primary },
    );
  }

  #inconsistent(cause: unknown): never {
    throw new RecoveryOnlyTerminalPublicationError(
      "recovery_result_inconsistent",
      "Recovery-only terminal result is inconsistent.",
      { cause },
    );
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
