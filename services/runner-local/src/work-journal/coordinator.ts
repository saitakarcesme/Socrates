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
import {
  immutableEvidenceSnapshot,
  terminalActiveWorkSnapshot,
  terminalCompletedWorkSnapshot,
  terminalDispositionSnapshot,
  terminalExecutionSnapshot,
  TerminalEvidenceConsistencyError,
} from "./terminal-evidence-consistency";
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

function inconsistent(): never {
  throw new WorkAdmissionError(
    "terminal_recovery_inconsistent",
    "Terminal recovery evidence is inconsistent.",
  );
}

function consistent<T>(operation: () => T): T {
  try {
    return operation();
  } catch (cause) {
    if (cause instanceof TerminalEvidenceConsistencyError) inconsistent();
    throw cause;
  }
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
    const execution = consistent(() => terminalExecutionSnapshot(stored));
    consistent(() => terminalActiveWorkSnapshot(work, execution));
    return execution;
  }

  async #prepareRecoveredActive(
    source: WorkJournalState,
    execution: RunnerExecutionV1,
    recovered: boolean,
    signal?: AbortSignal,
  ): Promise<WorkAdmissionResult> {
    if (!recovered) inconsistent();
    const baseline = consistent(() =>
      terminalActiveWorkSnapshot(source, execution),
    );
    const audited = await this.#terminalEvidence.audit(
      source.deliveryId,
      execution,
    );
    const disposition = consistent(() =>
      terminalDispositionSnapshot(audited, baseline, execution),
    );
    if (disposition.state === "completed") {
      return immutableEvidenceSnapshot({
        state: "completed",
        execution,
        work: disposition.work,
        recovered: true,
      });
    }
    if (disposition.state === "acknowledged") {
      const recovered = await this.#terminalEvidence.recover(
        source.deliveryId,
        execution,
      );
      const terminal = consistent(() => immutableEvidenceSnapshot(recovered));
      if (!terminal || terminal.state !== "completed") inconsistent();
      const completed = consistent(() =>
        terminalCompletedWorkSnapshot(
          terminal.work,
          baseline,
          execution,
          disposition.acknowledgedSequence,
        ),
      );
      return immutableEvidenceSnapshot({
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
        return immutableEvidenceSnapshot({
          state: "recovery_pending",
          deliveryId: work.deliveryId,
          execution,
          work,
          recovered: true,
          observedAt: reconciliation.observedAt,
          leaseExpiresAt: reconciliation.leaseExpiresAt,
        });
      }
      if (work.state === "claimed") {
        return immutableEvidenceSnapshot({
          state: "ready",
          deliveryId: work.deliveryId,
          execution,
          recovered: true,
        });
      }
      return immutableEvidenceSnapshot({
        state: "indeterminate",
        execution,
        work,
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
    return immutableEvidenceSnapshot({
      state: "retired",
      execution,
      work: retired,
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
