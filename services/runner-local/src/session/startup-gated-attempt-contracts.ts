import {
  runnerAttemptRetirementReasonV1Schema,
  runnerCancellationV1Schema,
  runnerTaskDeliveryV1Schema,
  type RunnerExecutionV1,
} from "@socrates/contracts";
import { z } from "zod";

import type { TerminalOutcomeNoEvidenceReason } from "../lifecycle";
import { sandboxTerminationReceipt } from "../oci/termination";
import { attemptKeyFor } from "../spool/codec";
import type { RunnerStartupRecoveryResult } from "../execution";
import type { WorkJournalState } from "../work-journal/contracts";
import { workRejectionCoreSchema } from "../work-journal/contracts";
import type { WorkAdmissionResult } from "../work-journal/coordinator";
import {
  immutableEvidenceSnapshot,
  terminalActiveWorkSnapshot,
  terminalCompletedWorkSnapshot,
  terminalExecutionSnapshot,
} from "../work-journal/terminal-evidence-consistency";
import type { TerminalPublicationOwnershipResult } from "../work-journal/terminal-publication-owner";
import {
  freshAttemptHandoffSnapshot,
  type FreshAttemptSessionResult,
  type ReadyWorkAdmission,
} from "./fresh-attempt-session";
import {
  restartTerminalRecoveryHandoffSnapshot,
  type RecoveryPendingWorkAdmission,
} from "./restart-terminal-recovery-session";

export interface StartupGatedWorkAdmissionPort {
  prepareNext(signal?: AbortSignal): Promise<WorkAdmissionResult>;
}

export interface StartupGatedFreshSessionPort {
  settle(): Promise<FreshAttemptSessionResult>;
}

export interface StartupGatedRestartSessionPort {
  settle(): Promise<TerminalPublicationOwnershipResult>;
}

export type StartupGatedAttemptComposition = Readonly<{
  admission: StartupGatedWorkAdmissionPort;
  createFresh(admission: ReadyWorkAdmission): StartupGatedFreshSessionPort;
  createRestartRecovery(
    admission: RecoveryPendingWorkAdmission,
  ): StartupGatedRestartSessionPort;
}>;

export interface StartupGatedAttemptCompositionFactory {
  compose(
    startup: RunnerStartupRecoveryResult,
  ): Promise<StartupGatedAttemptComposition>;
}

export type NonSessionAdmissionResult = Exclude<
  WorkAdmissionResult,
  Readonly<{ state: "ready" | "recovery_pending" }>
>;

export type StartupGatedAttemptDispatchResult =
  | NonSessionAdmissionResult
  | Readonly<{
      state: "settled";
      path: "fresh";
      deliveryId: string;
      execution: RunnerExecutionV1;
      result: FreshAttemptSessionResult;
    }>
  | Readonly<{
      state: "settled";
      path: "restart_recovery";
      deliveryId: string;
      execution: RunnerExecutionV1;
      result: TerminalPublicationOwnershipResult;
    }>;

export class StartupGatedAttemptDispatcherError extends Error {
  constructor(
    readonly code:
      "invalid_admission" | "invalid_composition" | "invalid_session_result",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "StartupGatedAttemptDispatcherError";
    Object.freeze(this);
  }
}

export type CapturedComposition = Readonly<{
  prepareNext(signal?: AbortSignal): Promise<WorkAdmissionResult>;
  createFresh(admission: ReadyWorkAdmission): StartupGatedFreshSessionPort;
  createRestartRecovery(
    admission: RecoveryPendingWorkAdmission,
  ): StartupGatedRestartSessionPort;
}>;

function record(candidate: unknown): Record<string, unknown> {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate)
  ) {
    throw new TypeError("Expected an object.");
  }
  return candidate as Record<string, unknown>;
}

function exactKeys(
  candidate: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(candidate).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

function instant(candidate: unknown): string {
  return z.iso.datetime().parse(candidate);
}

function recovered(candidate: unknown): boolean {
  if (typeof candidate !== "boolean") {
    throw new TypeError("Admission recovery flag is invalid.");
  }
  return candidate;
}

function sameExecutionIdentity(
  execution: RunnerExecutionV1,
  candidate: {
    runnerId: string;
    taskId: string;
    attemptId: string;
    fence: number;
  },
): boolean {
  const lease = execution.lease;
  return (
    candidate.runnerId === lease.runnerId &&
    candidate.taskId === lease.taskId &&
    candidate.attemptId === lease.attemptId &&
    candidate.fence === lease.fence
  );
}

function activeBaseline(
  candidate: Record<string, unknown>,
  execution: RunnerExecutionV1,
): WorkJournalState {
  const started = Object.hasOwn(candidate, "executionStartedAt");
  return terminalActiveWorkSnapshot(
    {
      deliveryId: candidate["deliveryId"],
      taskId: candidate["taskId"],
      attemptId: candidate["attemptId"],
      state: started ? "execution_started" : "claimed",
      admittedAt: candidate["admittedAt"],
      claimedAt: candidate["claimedAt"],
      ...(started
        ? { executionStartedAt: candidate["executionStartedAt"] }
        : {}),
    },
    execution,
  );
}

function completedWorkSnapshot(
  candidate: unknown,
  execution: RunnerExecutionV1,
): WorkJournalState {
  const value = record(immutableEvidenceSnapshot(candidate));
  const completion = record(value["completion"]);
  const acknowledgedSequence = completion["acknowledgedSequence"];
  if (
    value["state"] !== "completed" ||
    !Number.isSafeInteger(acknowledgedSequence) ||
    Number(acknowledgedSequence) < 1 ||
    completion["attemptKey"] !== attemptKeyFor(execution)
  ) {
    throw new TypeError("Completed work is invalid.");
  }
  const baseline = activeBaseline(value, execution);
  return terminalCompletedWorkSnapshot(
    value,
    baseline,
    execution,
    Number(acknowledgedSequence),
  );
}

function retiredWorkSnapshot(
  candidate: unknown,
  execution: RunnerExecutionV1,
): WorkJournalState {
  const value = record(immutableEvidenceSnapshot(candidate));
  const started = Object.hasOwn(value, "executionStartedAt");
  const expected = [
    "admittedAt",
    "attemptId",
    "claimedAt",
    "deliveryId",
    ...(started ? ["executionStartedAt"] : []),
    "retiredAt",
    "retirement",
    "state",
    "taskId",
  ];
  if (value["state"] !== "retired" || !exactKeys(value, expected)) {
    throw new TypeError("Retired work is invalid.");
  }
  const baseline = activeBaseline(value, execution);
  const retirement = record(value["retirement"]);
  if (!exactKeys(retirement, ["observedAt", "reason"])) {
    throw new TypeError("Work retirement is invalid.");
  }
  return immutableEvidenceSnapshot({
    ...baseline,
    state: "retired" as const,
    retiredAt: instant(value["retiredAt"]),
    retirement: {
      observedAt: instant(retirement["observedAt"]),
      reason: runnerAttemptRetirementReasonV1Schema.parse(retirement["reason"]),
    },
  });
}

function rejectedWorkSnapshot(candidate: unknown): WorkJournalState {
  const value = record(immutableEvidenceSnapshot(candidate));
  if (
    value["state"] !== "rejected" ||
    !exactKeys(value, [
      "admittedAt",
      "attemptId",
      "deliveryId",
      "rejectedAt",
      "rejection",
      "state",
      "taskId",
    ])
  ) {
    throw new TypeError("Rejected work is invalid.");
  }
  const delivery = runnerTaskDeliveryV1Schema.parse({
    version: "1",
    deliveryId: value["deliveryId"],
    taskId: value["taskId"],
  });
  const attemptId = z.uuid().parse(value["attemptId"]);
  const rejection = record(value["rejection"]);
  if (
    !exactKeys(rejection, ["apiCode", "reason", "requestId", "status"]) ||
    rejection["reason"] !== "control_plane_conflict"
  ) {
    throw new TypeError("Work rejection is invalid.");
  }
  const response = workRejectionCoreSchema.shape.response.parse({
    status: rejection["status"],
    apiCode: rejection["apiCode"],
    requestId: rejection["requestId"],
  });
  return immutableEvidenceSnapshot({
    deliveryId: delivery.deliveryId,
    taskId: delivery.taskId,
    attemptId,
    state: "rejected" as const,
    admittedAt: instant(value["admittedAt"]),
    rejectedAt: instant(value["rejectedAt"]),
    rejection: {
      reason: "control_plane_conflict" as const,
      ...response,
    },
  });
}

export function nonSessionAdmissionSnapshot(
  candidate: WorkAdmissionResult,
): NonSessionAdmissionResult {
  try {
    const value = record(immutableEvidenceSnapshot(candidate));
    if (value["state"] === "idle" && exactKeys(value, ["state"])) {
      return Object.freeze({ state: "idle" });
    }
    if (
      value["state"] === "rejected" &&
      exactKeys(value, ["recovered", "state", "work"])
    ) {
      return immutableEvidenceSnapshot({
        state: "rejected" as const,
        work: rejectedWorkSnapshot(value["work"]),
        recovered: recovered(value["recovered"]),
      });
    }
    if (
      value["state"] === "indeterminate" &&
      exactKeys(value, [
        "execution",
        "leaseExpiresAt",
        "observedAt",
        "recovered",
        "state",
        "work",
      ]) &&
      value["recovered"] === true
    ) {
      const execution = terminalExecutionSnapshot(value["execution"]);
      return immutableEvidenceSnapshot({
        state: "indeterminate" as const,
        execution,
        work: terminalActiveWorkSnapshot(value["work"], execution),
        recovered: true as const,
        observedAt: instant(value["observedAt"]),
        leaseExpiresAt: instant(value["leaseExpiresAt"]),
      });
    }
    if (
      (value["state"] === "retired" || value["state"] === "completed") &&
      exactKeys(value, ["execution", "recovered", "state", "work"])
    ) {
      const execution = terminalExecutionSnapshot(value["execution"]);
      const wasRecovered = recovered(value["recovered"]);
      if (value["state"] === "retired") {
        return immutableEvidenceSnapshot({
          state: "retired" as const,
          execution,
          work: retiredWorkSnapshot(value["work"], execution),
          recovered: wasRecovered,
        });
      }
      return immutableEvidenceSnapshot({
        state: "completed" as const,
        execution,
        work: completedWorkSnapshot(value["work"], execution),
        recovered: wasRecovered,
      });
    }
    throw new TypeError("Admission state is invalid.");
  } catch (cause) {
    throw new StartupGatedAttemptDispatcherError(
      "invalid_admission",
      "Startup-gated work admission result is invalid.",
      { cause },
    );
  }
}

const admissionStates = new Set<WorkAdmissionResult["state"]>([
  "completed",
  "idle",
  "indeterminate",
  "ready",
  "recovery_pending",
  "rejected",
  "retired",
]);

export function admissionState(
  candidate: unknown,
): WorkAdmissionResult["state"] {
  try {
    const value = record(candidate);
    const state = value["state"] as WorkAdmissionResult["state"];
    if (!admissionStates.has(state)) {
      throw new TypeError("Admission state is invalid.");
    }
    return state;
  } catch (cause) {
    throw new StartupGatedAttemptDispatcherError(
      "invalid_admission",
      "Startup-gated work admission result is invalid.",
      { cause },
    );
  }
}

export function readyAdmissionSnapshot(candidate: unknown): ReadyWorkAdmission {
  try {
    return freshAttemptHandoffSnapshot(candidate);
  } catch (cause) {
    throw new StartupGatedAttemptDispatcherError(
      "invalid_admission",
      "Startup-gated work admission result is invalid.",
      { cause },
    );
  }
}

export function recoveryAdmissionSnapshot(
  candidate: unknown,
): RecoveryPendingWorkAdmission {
  try {
    return restartTerminalRecoveryHandoffSnapshot(candidate);
  } catch (cause) {
    throw new StartupGatedAttemptDispatcherError(
      "invalid_admission",
      "Startup-gated work admission result is invalid.",
      { cause },
    );
  }
}

function cancellationAuthoritySnapshot(
  candidate: Record<string, unknown>,
  execution: RunnerExecutionV1,
) {
  if (!exactKeys(candidate, ["cancellation", "state", "termination"])) {
    throw new TypeError("Cancellation authority is invalid.");
  }
  const cancellation = runnerCancellationV1Schema.parse(
    candidate["cancellation"],
  );
  if (!sameExecutionIdentity(execution, cancellation)) {
    throw new TypeError("Cancellation authority identity is invalid.");
  }
  return immutableEvidenceSnapshot({
    state: "cancelled" as const,
    cancellation,
    termination: sandboxTerminationReceipt(candidate["termination"]),
  });
}

function completedAuthoritySnapshot(
  candidate: unknown,
  execution: RunnerExecutionV1,
) {
  const value = record(immutableEvidenceSnapshot(candidate));
  if (
    (value["state"] === "stopped" || value["state"] === "stale") &&
    exactKeys(value, ["state"])
  ) {
    return Object.freeze({ state: value["state"] });
  }
  if (value["state"] === "cancelled") {
    return cancellationAuthoritySnapshot(value, execution);
  }
  throw new TypeError("Completed authority is invalid.");
}

function ownershipSnapshot(
  candidate: unknown,
  execution: RunnerExecutionV1,
): TerminalPublicationOwnershipResult {
  const value = record(immutableEvidenceSnapshot(candidate));
  if (
    value["state"] !== "completed" ||
    !exactKeys(value, ["authority", "publication", "state"])
  ) {
    throw new TypeError("Publication ownership result is invalid.");
  }
  const publication = record(value["publication"]);
  if (
    publication["state"] !== "completed" ||
    (publication["publication"] !== "appended" &&
      publication["publication"] !== "recovered") ||
    !exactKeys(publication, ["publication", "state", "work"])
  ) {
    throw new TypeError("Terminal publication result is invalid.");
  }
  return immutableEvidenceSnapshot({
    state: "completed" as const,
    publication: {
      state: "completed" as const,
      publication: publication["publication"],
      work: completedWorkSnapshot(publication["work"], execution),
    },
    authority: completedAuthoritySnapshot(value["authority"], execution),
  });
}

const noEvidenceReasons = new Set<TerminalOutcomeNoEvidenceReason>([
  "authority_lost",
  "authority_uncertain",
  "candidate_missing",
  "observation_conflict",
  "observation_uncertain",
]);

function noEvidenceAuthoritySnapshot(
  candidate: unknown,
  execution: RunnerExecutionV1,
) {
  const value = record(immutableEvidenceSnapshot(candidate));
  if (value["state"] === "cancelled") {
    return cancellationAuthoritySnapshot(value, execution);
  }
  if (value["state"] === "stale" && exactKeys(value, ["state"])) {
    return Object.freeze({ state: "stale" as const });
  }
  if (
    value["state"] === "released" &&
    value["reason"] === "terminal_evidence_unavailable" &&
    exactKeys(value, ["reason", "state"])
  ) {
    return Object.freeze({
      state: "released" as const,
      reason: "terminal_evidence_unavailable" as const,
    });
  }
  throw new TypeError("No-evidence authority is invalid.");
}

export function freshSessionResultSnapshot(
  candidate: unknown,
  execution: RunnerExecutionV1,
): FreshAttemptSessionResult {
  try {
    const value = record(immutableEvidenceSnapshot(candidate));
    if (value["state"] === "completed") {
      return ownershipSnapshot(value, execution);
    }
    if (
      value["state"] === "no_evidence" &&
      exactKeys(value, ["authority", "reason", "state"]) &&
      noEvidenceReasons.has(value["reason"] as TerminalOutcomeNoEvidenceReason)
    ) {
      return immutableEvidenceSnapshot({
        state: "no_evidence" as const,
        reason: value["reason"] as TerminalOutcomeNoEvidenceReason,
        authority: noEvidenceAuthoritySnapshot(value["authority"], execution),
      });
    }
    throw new TypeError("Fresh session result is invalid.");
  } catch (cause) {
    throw new StartupGatedAttemptDispatcherError(
      "invalid_session_result",
      "Startup-gated session result is invalid.",
      { cause },
    );
  }
}

export function restartSessionResultSnapshot(
  candidate: unknown,
  execution: RunnerExecutionV1,
): TerminalPublicationOwnershipResult {
  try {
    return ownershipSnapshot(candidate, execution);
  } catch (cause) {
    throw new StartupGatedAttemptDispatcherError(
      "invalid_session_result",
      "Startup-gated session result is invalid.",
      { cause },
    );
  }
}

export function capturedComposition(candidate: unknown): CapturedComposition {
  try {
    const value = record(candidate);
    if (
      !exactKeys(value, [
        "admission",
        "createFresh",
        "createRestartRecovery",
      ]) ||
      typeof value["createFresh"] !== "function" ||
      typeof value["createRestartRecovery"] !== "function"
    ) {
      throw new TypeError("Attempt composition is invalid.");
    }
    const admission = record(value["admission"]);
    if (typeof admission["prepareNext"] !== "function") {
      throw new TypeError("Admission composition is invalid.");
    }
    const source = candidate as StartupGatedAttemptComposition;
    return Object.freeze({
      prepareNext: source.admission.prepareNext.bind(source.admission),
      createFresh: source.createFresh.bind(source),
      createRestartRecovery: source.createRestartRecovery.bind(source),
    });
  } catch (cause) {
    throw new StartupGatedAttemptDispatcherError(
      "invalid_composition",
      "Startup-gated attempt composition is invalid.",
      { cause },
    );
  }
}
