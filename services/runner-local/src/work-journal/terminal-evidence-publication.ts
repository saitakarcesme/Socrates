import {
  runnerExecutionV1Schema,
  runnerTaskDeliveryV1Schema,
  type RunnerEventV2,
  type RunnerExecutionV1,
} from "@socrates/contracts";

import {
  terminalRunnerEventDrafts,
  type RunnerEventDraft,
} from "../lifecycle/draft";
import type { WorkJournalState } from "./contracts";
import { executionDigestFor } from "./codec";
import type { TerminalEvidenceRecoveryResult } from "./terminal-evidence-recovery";
import {
  TerminalPublicationDispositionAuditor,
  type TerminalDispositionSpool,
  type TerminalPublicationDisposition,
} from "./terminal-publication-disposition";

export interface TerminalPublicationWorkJournal {
  inspect(deliveryId: string): Promise<WorkJournalState | null>;
  claimedExecution(deliveryId: string): Promise<RunnerExecutionV1 | null>;
}

export interface TerminalEvidenceAppender extends TerminalDispositionSpool {
  append(
    execution: RunnerExecutionV1,
    drafts: readonly RunnerEventDraft[],
  ): Promise<readonly RunnerEventV2[]>;
}

export interface TerminalPublicationRecoveryPort {
  recover(
    deliveryId: string,
    execution: RunnerExecutionV1,
  ): Promise<TerminalEvidenceRecoveryResult>;
}

export type TerminalEvidencePublicationResult = Readonly<{
  state: "completed";
  publication: "appended" | "recovered";
  work: WorkJournalState;
}>;

export type TerminalPublicationFailureBoundary =
  "append" | "recovery_after_append" | "recovery_before_append";

export class TerminalEvidencePublicationError extends Error {
  constructor(
    readonly code:
      | "completed_evidence_missing"
      | "identity_conflict"
      | "invalid_input"
      | "publication_not_recoverable"
      | "work_not_publishable",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TerminalEvidencePublicationError";
  }
}

export class TerminalEvidencePublicationStateUncertainError extends Error {
  readonly code = "publication_state_uncertain" as const;

  constructor(
    readonly boundary: TerminalPublicationFailureBoundary,
    options?: ErrorOptions,
  ) {
    super("Terminal evidence publication state is uncertain.", options);
    this.name = "TerminalEvidencePublicationStateUncertainError";
    Object.freeze(this);
  }
}

export class TerminalEvidencePublicationDeferredError extends Error {
  readonly code = "publication_deferred" as const;

  constructor(
    readonly boundary: TerminalPublicationFailureBoundary,
    readonly disposition: TerminalPublicationDisposition,
    options?: ErrorOptions,
  ) {
    super("Terminal evidence publication requires deferred recovery.", options);
    this.name = "TerminalEvidencePublicationDeferredError";
    Object.freeze(this);
  }
}

type PublicationInput = Readonly<{
  deliveryId: string;
  execution: RunnerExecutionV1;
  drafts: readonly RunnerEventDraft[];
}>;

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function parseInput(candidate: PublicationInput): PublicationInput {
  try {
    return deepFreeze({
      deliveryId: runnerTaskDeliveryV1Schema.shape.deliveryId.parse(
        candidate.deliveryId,
      ),
      execution: runnerExecutionV1Schema.parse(candidate.execution),
      drafts: terminalRunnerEventDrafts(candidate.drafts),
    });
  } catch (cause) {
    throw new TerminalEvidencePublicationError(
      "invalid_input",
      "Terminal evidence publication input is invalid.",
      { cause },
    );
  }
}

function active(state: WorkJournalState): boolean {
  return state.state === "claimed" || state.state === "execution_started";
}

export class TerminalEvidencePublicationCoordinator {
  #operationTail: Promise<void> = Promise.resolve();
  readonly #auditor: TerminalPublicationDispositionAuditor;

  constructor(
    private readonly journal: TerminalPublicationWorkJournal,
    private readonly spool: TerminalEvidenceAppender,
    private readonly recovery: TerminalPublicationRecoveryPort,
  ) {
    this.#auditor = new TerminalPublicationDispositionAuditor(journal, spool);
  }

  async publish(
    candidate: PublicationInput,
  ): Promise<TerminalEvidencePublicationResult> {
    const input = parseInput(candidate);
    return this.#serialize(async () => {
      const initialWork = await this.#requireBoundWork(input);
      let existing: TerminalEvidenceRecoveryResult;
      try {
        existing = await this.recovery.recover(
          input.deliveryId,
          input.execution,
        );
      } catch (cause) {
        return this.#afterFailure(input, "recovery_before_append", cause);
      }
      if (existing.state === "completed") {
        return deepFreeze({
          state: "completed" as const,
          publication: "recovered" as const,
          work: existing.work,
        });
      }
      if (initialWork.state === "completed") {
        throw new TerminalEvidencePublicationError(
          "completed_evidence_missing",
          "Completed work has no recoverable terminal evidence.",
        );
      }

      const currentWork = await this.#requireBoundWork(input);
      if (!active(currentWork)) {
        throw new TerminalEvidencePublicationError(
          "work_not_publishable",
          "Work became non-publishable before terminal evidence append.",
        );
      }
      try {
        await this.spool.append(input.execution, input.drafts);
      } catch (cause) {
        return this.#afterFailure(input, "append", cause);
      }

      let completed: TerminalEvidenceRecoveryResult;
      try {
        completed = await this.recovery.recover(
          input.deliveryId,
          input.execution,
        );
      } catch (cause) {
        return this.#afterFailure(input, "recovery_after_append", cause);
      }
      if (completed.state !== "completed") {
        throw new TerminalEvidencePublicationError(
          "publication_not_recoverable",
          "Appended terminal evidence did not become recoverable completion.",
        );
      }
      return deepFreeze({
        state: "completed" as const,
        publication: "appended" as const,
        work: completed.work,
      });
    });
  }

  async #afterFailure(
    input: PublicationInput,
    boundary: TerminalPublicationFailureBoundary,
    primaryCause: unknown,
  ): Promise<TerminalEvidencePublicationResult> {
    let disposition: TerminalPublicationDisposition;
    try {
      disposition = await this.#auditor.audit(
        input.deliveryId,
        input.execution,
      );
    } catch (auditCause) {
      throw new TerminalEvidencePublicationStateUncertainError(boundary, {
        cause: new AggregateError([primaryCause, auditCause]),
      });
    }
    if (disposition.state === "completed") {
      return deepFreeze({
        state: "completed",
        publication: "recovered",
        work: disposition.work,
      });
    }
    throw new TerminalEvidencePublicationDeferredError(boundary, disposition, {
      cause: primaryCause,
    });
  }

  async #requireBoundWork(input: PublicationInput): Promise<WorkJournalState> {
    const work = await this.journal.inspect(input.deliveryId);
    if (!work) {
      throw new TerminalEvidencePublicationError(
        "work_not_publishable",
        "Terminal evidence delivery is absent from the work journal.",
      );
    }
    if (
      work.deliveryId !== input.deliveryId ||
      work.taskId !== input.execution.lease.taskId ||
      work.attemptId !== input.execution.lease.attemptId
    ) {
      throw new TerminalEvidencePublicationError(
        "identity_conflict",
        "Terminal evidence does not match the journal work identity.",
      );
    }
    if (!active(work) && work.state !== "completed") {
      throw new TerminalEvidencePublicationError(
        "work_not_publishable",
        "Journal work state cannot publish terminal evidence.",
      );
    }
    const execution = await this.journal.claimedExecution(input.deliveryId);
    if (
      !execution ||
      executionDigestFor(execution) !== executionDigestFor(input.execution)
    ) {
      throw new TerminalEvidencePublicationError(
        "identity_conflict",
        "Terminal evidence execution does not match the durable claim.",
      );
    }
    return work;
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
