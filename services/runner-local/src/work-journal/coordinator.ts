import {
  runnerExecutionV1Schema,
  type RunnerExecutionV1,
  type RunnerTaskDeliveryV1,
} from "@socrates/contracts";

import {
  RunnerTransportError,
  type RunnerControlPlaneClient,
} from "../transport/client";
import { attemptKeyFor } from "../spool/codec";
import { WorkJournalError, type WorkJournalState } from "./contracts";
import { ExactClaimReconciler } from "./reconciler";
import { LocalWorkJournal } from "./store";
import type { TerminalEvidenceRecoveryResult } from "./terminal-evidence-recovery";
import type { TerminalPublicationDisposition } from "./terminal-publication-disposition";

export interface TerminalAdmissionEvidencePort {
  audit(
    deliveryId: string,
    execution: RunnerExecutionV1,
  ): Promise<TerminalPublicationDisposition>;
  recover(
    deliveryId: string,
    execution: RunnerExecutionV1,
  ): Promise<TerminalEvidenceRecoveryResult>;
}

export class WorkAdmissionError extends Error {
  constructor(
    readonly code: "terminal_recovery_inconsistent",
    message: string,
  ) {
    super(message);
    this.name = "WorkAdmissionError";
  }
}

export type WorkAdmissionResult =
  | Readonly<{ state: "idle" }>
  | Readonly<{
      state: "ready";
      deliveryId: string;
      execution: RunnerExecutionV1;
      recovered: boolean;
    }>
  | Readonly<{
      state: "rejected";
      work: WorkJournalState;
      recovered: boolean;
    }>
  | Readonly<{
      state: "indeterminate";
      execution: RunnerExecutionV1;
      work: WorkJournalState;
      recovered: boolean;
      observedAt: string;
      leaseExpiresAt: string;
    }>
  | Readonly<{
      state: "recovery_pending";
      deliveryId: string;
      execution: RunnerExecutionV1;
      work: WorkJournalState;
      recovered: true;
      observedAt: string;
      leaseExpiresAt: string;
    }>
  | Readonly<{
      state: "retired";
      execution: RunnerExecutionV1;
      work: WorkJournalState;
      recovered: boolean;
    }>
  | Readonly<{
      state: "completed";
      execution: RunnerExecutionV1;
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

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function inconsistent(): never {
  throw new WorkAdmissionError(
    "terminal_recovery_inconsistent",
    "Terminal recovery evidence is inconsistent.",
  );
}

function immutableCopy<T>(value: T): T {
  try {
    return deepFreeze(structuredClone(value));
  } catch {
    return inconsistent();
  }
}

function immutableExecution(input: RunnerExecutionV1): RunnerExecutionV1 {
  try {
    return deepFreeze(runnerExecutionV1Schema.parse(input));
  } catch {
    return inconsistent();
  }
}

function assertExecutionIdentity(
  work: WorkJournalState,
  execution: RunnerExecutionV1,
): void {
  if (
    work.taskId !== execution.lease.taskId ||
    work.attemptId !== execution.lease.attemptId
  ) {
    inconsistent();
  }
}

function safeCounter(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function assertCompletedWork(
  work: WorkJournalState,
  execution: RunnerExecutionV1,
  acknowledgedSequence: number,
): void {
  if (
    work.state !== "completed" ||
    typeof work.completedAt !== "string" ||
    !work.completion ||
    work.completion.attemptKey !== attemptKeyFor(execution) ||
    work.completion.acknowledgedSequence !== acknowledgedSequence ||
    acknowledgedSequence < 1
  ) {
    inconsistent();
  }
}

function assertWorkContinuity(
  source: WorkJournalState,
  observed: WorkJournalState,
): void {
  if (
    observed.deliveryId !== source.deliveryId ||
    observed.taskId !== source.taskId ||
    observed.attemptId !== source.attemptId ||
    observed.admittedAt !== source.admittedAt ||
    observed.claimedAt !== source.claimedAt ||
    observed.executionStartedAt !== source.executionStartedAt
  ) {
    inconsistent();
  }
}

function dispositionSnapshot(
  input: TerminalPublicationDisposition,
  source: WorkJournalState,
  execution: RunnerExecutionV1,
): TerminalPublicationDisposition {
  const disposition = immutableCopy(input);
  if (
    !disposition ||
    !["absent", "pending", "acknowledged", "completed"].includes(
      disposition.state,
    )
  ) {
    inconsistent();
  }
  const work = disposition.work;
  if (!work) inconsistent();
  assertWorkContinuity(source, work);
  assertExecutionIdentity(work, execution);
  if (disposition.state === "completed") {
    assertCompletedWork(work, execution, disposition.acknowledgedSequence);
  } else if (work.state !== source.state) {
    inconsistent();
  }
  if (disposition.state !== "absent") {
    const { acknowledgedSequence, lastSequence, pendingEvents } = disposition;
    if (
      !safeCounter(acknowledgedSequence) ||
      !safeCounter(lastSequence) ||
      !safeCounter(pendingEvents) ||
      lastSequence < 1 ||
      acknowledgedSequence > lastSequence ||
      pendingEvents !== lastSequence - acknowledgedSequence ||
      (disposition.state === "pending"
        ? pendingEvents < 1
        : pendingEvents !== 0)
    ) {
      inconsistent();
    }
  }
  return disposition;
}

export class WorkAdmissionCoordinator {
  readonly #journal: LocalWorkJournal;
  readonly #client: RunnerControlPlaneClient;
  readonly #claims: ExactClaimReconciler;
  readonly #terminalEvidence: TerminalAdmissionEvidencePort;
  #operationTail: Promise<void> = Promise.resolve();

  constructor(options: {
    journal: LocalWorkJournal;
    client: RunnerControlPlaneClient;
    leaseDurationMs: number;
    terminalEvidence: TerminalAdmissionEvidencePort;
  }) {
    this.#journal = options.journal;
    this.#client = options.client;
    this.#claims = new ExactClaimReconciler(options);
    this.#terminalEvidence = options.terminalEvidence;
  }

  async prepareNext(signal?: AbortSignal): Promise<WorkAdmissionResult> {
    return this.#serialize(async () => {
      const local = ordered(await this.#journal.list());
      const actionable = local.find(
        (work) =>
          work.state === "pending_claim" ||
          work.state === "claimed" ||
          work.state === "execution_started",
      );
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
    if (work.state === "execution_started") {
      const execution = await this.#activeExecution(
        work,
        "Started work has no durable execution.",
      );
      return this.#prepareRecoveredActive(work, execution, recovered, signal);
    }
    if (work.state === "claimed") {
      const execution = await this.#activeExecution(
        work,
        "Claimed journal state has no durable execution.",
      );
      return this.#prepareRecoveredActive(work, execution, recovered, signal);
    }

    try {
      const execution = await this.#claims.reconcile(deliveryFor(work), signal);
      return Object.freeze({
        state: "ready",
        deliveryId: work.deliveryId,
        execution,
        recovered,
      });
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

  async #activeExecution(
    work: WorkJournalState,
    missingMessage: string,
  ): Promise<RunnerExecutionV1> {
    const stored = await this.#journal.claimedExecution(work.deliveryId);
    if (!stored) throw new WorkJournalError("corrupt", missingMessage);
    const execution = immutableExecution(stored);
    assertExecutionIdentity(work, execution);
    return execution;
  }

  async #prepareRecoveredActive(
    source: WorkJournalState,
    execution: RunnerExecutionV1,
    recovered: boolean,
    signal?: AbortSignal,
  ): Promise<WorkAdmissionResult> {
    if (!recovered) inconsistent();
    const disposition = dispositionSnapshot(
      await this.#terminalEvidence.audit(source.deliveryId, execution),
      source,
      execution,
    );
    if (disposition.state === "completed") {
      return deepFreeze({
        state: "completed",
        execution,
        work: disposition.work,
        recovered: true,
      });
    }
    if (disposition.state === "acknowledged") {
      const terminal = immutableCopy(
        await this.#terminalEvidence.recover(source.deliveryId, execution),
      );
      if (!terminal || terminal.state !== "completed") inconsistent();
      const completed = terminal.work;
      if (!completed || completed.state !== "completed") {
        inconsistent();
      }
      assertWorkContinuity(source, completed);
      assertExecutionIdentity(completed, execution);
      assertCompletedWork(
        completed,
        execution,
        disposition.acknowledgedSequence,
      );
      return deepFreeze({
        state: "completed",
        execution,
        work: completed,
        recovered: true,
      });
    }

    return this.#reconcileActive(source, execution, disposition.state, signal);
  }

  async #reconcileActive(
    work: WorkJournalState,
    execution: RunnerExecutionV1,
    disposition: "absent" | "pending",
    signal?: AbortSignal,
  ): Promise<WorkAdmissionResult> {
    const reconciliation = await this.#client.reconcileAttempt(
      {
        taskId: execution.lease.taskId,
        attemptId: execution.lease.attemptId,
        request: { version: "1", fence: execution.lease.fence },
      },
      signal,
    );
    if (reconciliation.state === "current") {
      if (disposition === "pending") {
        return deepFreeze({
          state: "recovery_pending",
          deliveryId: work.deliveryId,
          execution,
          work: immutableCopy(work),
          recovered: true,
          observedAt: reconciliation.observedAt,
          leaseExpiresAt: reconciliation.leaseExpiresAt,
        });
      }
      if (work.state === "claimed") {
        return deepFreeze({
          state: "ready",
          deliveryId: work.deliveryId,
          execution,
          recovered: true,
        });
      }
      return deepFreeze({
        state: "indeterminate",
        execution,
        work: immutableCopy(work),
        recovered: true,
        observedAt: reconciliation.observedAt,
        leaseExpiresAt: reconciliation.leaseExpiresAt,
      });
    }
    const retired = await this.#journal.commitExecutionRetirement(
      work.deliveryId,
      execution,
      {
        observedAt: reconciliation.observedAt,
        reason: reconciliation.reason,
      },
    );
    return deepFreeze({
      state: "retired",
      execution,
      work: immutableCopy(retired),
      recovered: true,
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
