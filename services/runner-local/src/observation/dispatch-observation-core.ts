import { types } from "node:util";

import {
  apiErrorCodeSchema,
  runnerAttemptRetirementReasonV1Schema,
} from "@socrates/contracts";
import { canonicalJson } from "@socrates/runtime-protocol";
import { z } from "zod";

import type { StartupGatedAttemptDispatchResult } from "../session/startup-gated-attempt-contracts";
import {
  dispatchObservationFailure,
  localRunnerDispatchObservationSchema,
  maximumLocalRunnerDispatchObservationBytes,
} from "./dispatch-observation-contracts";

type ObservationScalar = string | number | boolean;
type ObservationRecord = Readonly<Record<string, ObservationScalar>>;

export interface DispatchObservationByteSink {
  write(bytes: Uint8Array): Promise<void>;
}

export type DispatchObservationCore = Readonly<{
  observe(result: StartupGatedAttemptDispatchResult): Promise<void>;
}>;

const encoder = new TextEncoder();
const entityId = z.uuid();
const instant = z.iso.datetime();
const settledPaths = new Set(["fresh", "restart_recovery"]);
const publicationStates = new Set(["appended", "recovered"]);
const completedAuthorityStates = new Set(["cancelled", "stale", "stopped"]);
const noEvidenceAuthorityStates = new Set(["cancelled", "released", "stale"]);
const noEvidenceReasons = new Set([
  "authority_lost",
  "authority_uncertain",
  "candidate_missing",
  "observation_conflict",
  "observation_uncertain",
]);

function plainFrozenRecord(candidate: unknown): Record<string, unknown> {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate) ||
    types.isProxy(candidate) ||
    Object.getPrototypeOf(candidate) !== Object.prototype ||
    !Object.isFrozen(candidate)
  ) {
    return dispatchObservationFailure("projection_failed");
  }
  return candidate as Record<string, unknown>;
}

function dataValue(candidate: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
  if (
    descriptor === undefined ||
    !("value" in descriptor) ||
    descriptor.get !== undefined ||
    descriptor.set !== undefined ||
    descriptor.enumerable !== true
  ) {
    return dispatchObservationFailure("projection_failed");
  }
  return descriptor.value;
}

function enumValue(candidate: unknown, allowed: ReadonlySet<string>): string {
  if (typeof candidate !== "string" || !allowed.has(candidate)) {
    return dispatchObservationFailure("projection_failed");
  }
  return candidate;
}

function booleanValue(candidate: unknown): boolean {
  if (typeof candidate !== "boolean") {
    return dispatchObservationFailure("projection_failed");
  }
  return candidate;
}

function positiveSafeInteger(candidate: unknown): number {
  if (!Number.isSafeInteger(candidate) || Number(candidate) < 1) {
    return dispatchObservationFailure("projection_failed");
  }
  return Number(candidate);
}

function identity(executionCandidate: unknown) {
  const execution = plainFrozenRecord(executionCandidate);
  const lease = plainFrozenRecord(dataValue(execution, "lease"));
  return Object.freeze({
    runnerId: entityId.parse(dataValue(lease, "runnerId")),
    taskId: entityId.parse(dataValue(lease, "taskId")),
    attemptId: entityId.parse(dataValue(lease, "attemptId")),
    fence: positiveSafeInteger(dataValue(lease, "fence")),
  });
}

function workIdentity(
  workCandidate: unknown,
  expected?: Readonly<{ taskId: string; attemptId: string }>,
) {
  const work = plainFrozenRecord(workCandidate);
  const value = Object.freeze({
    deliveryId: entityId.parse(dataValue(work, "deliveryId")),
    taskId: entityId.parse(dataValue(work, "taskId")),
    attemptId: entityId.parse(dataValue(work, "attemptId")),
  });
  if (
    expected !== undefined &&
    (value.taskId !== expected.taskId || value.attemptId !== expected.attemptId)
  ) {
    return dispatchObservationFailure("projection_failed");
  }
  return Object.freeze({ value, work });
}

function executionWork(result: Record<string, unknown>) {
  const lease = identity(dataValue(result, "execution"));
  const work = workIdentity(dataValue(result, "work"), lease);
  return Object.freeze({ ...lease, ...work.value, work: work.work });
}

function authorityState(
  candidate: unknown,
  allowed: ReadonlySet<string>,
): string {
  const authority = plainFrozenRecord(candidate);
  return enumValue(dataValue(authority, "state"), allowed);
}

function base(state: string): Record<string, ObservationScalar> {
  return {
    schema: localRunnerDispatchObservationSchema,
    state,
  };
}

function rejectedObservation(result: Record<string, unknown>) {
  const { value: work, work: source } = workIdentity(dataValue(result, "work"));
  const rejection = plainFrozenRecord(dataValue(source, "rejection"));
  if (
    dataValue(rejection, "reason") !== "control_plane_conflict" ||
    dataValue(rejection, "status") !== 409
  ) {
    return dispatchObservationFailure("projection_failed");
  }
  return Object.freeze({
    ...base("rejected"),
    ...work,
    recovered: booleanValue(dataValue(result, "recovered")),
    reason: "control_plane_conflict",
    status: 409,
    apiCode: apiErrorCodeSchema.parse(dataValue(rejection, "apiCode")),
  });
}

function indeterminateObservation(result: Record<string, unknown>) {
  const value = executionWork(result);
  if (dataValue(result, "recovered") !== true) {
    return dispatchObservationFailure("projection_failed");
  }
  return Object.freeze({
    ...base("indeterminate"),
    deliveryId: value.deliveryId,
    runnerId: value.runnerId,
    taskId: value.taskId,
    attemptId: value.attemptId,
    fence: value.fence,
    recovered: true,
    observedAt: instant.parse(dataValue(result, "observedAt")),
    leaseExpiresAt: instant.parse(dataValue(result, "leaseExpiresAt")),
  });
}

function retiredObservation(result: Record<string, unknown>) {
  const value = executionWork(result);
  const retirement = plainFrozenRecord(dataValue(value.work, "retirement"));
  return Object.freeze({
    ...base("retired"),
    deliveryId: value.deliveryId,
    runnerId: value.runnerId,
    taskId: value.taskId,
    attemptId: value.attemptId,
    fence: value.fence,
    recovered: booleanValue(dataValue(result, "recovered")),
    reason: runnerAttemptRetirementReasonV1Schema.parse(
      dataValue(retirement, "reason"),
    ),
  });
}

function completedObservation(result: Record<string, unknown>) {
  const value = executionWork(result);
  const completion = plainFrozenRecord(dataValue(value.work, "completion"));
  return Object.freeze({
    ...base("completed"),
    deliveryId: value.deliveryId,
    runnerId: value.runnerId,
    taskId: value.taskId,
    attemptId: value.attemptId,
    fence: value.fence,
    recovered: booleanValue(dataValue(result, "recovered")),
    acknowledgedSequence: positiveSafeInteger(
      dataValue(completion, "acknowledgedSequence"),
    ),
  });
}

function settledObservation(result: Record<string, unknown>) {
  const lease = identity(dataValue(result, "execution"));
  const deliveryId = entityId.parse(dataValue(result, "deliveryId"));
  const path = enumValue(dataValue(result, "path"), settledPaths);
  const outcome = plainFrozenRecord(dataValue(result, "result"));
  const outcomeState = dataValue(outcome, "state");
  const common = {
    ...base("settled"),
    deliveryId,
    ...lease,
    path,
  };
  if (outcomeState === "completed") {
    const publication = plainFrozenRecord(dataValue(outcome, "publication"));
    return Object.freeze({
      ...common,
      result: "completed",
      publication: enumValue(
        dataValue(publication, "publication"),
        publicationStates,
      ),
      authority: authorityState(
        dataValue(outcome, "authority"),
        completedAuthorityStates,
      ),
    });
  }
  if (outcomeState === "no_evidence" && path === "fresh") {
    return Object.freeze({
      ...common,
      result: "no_evidence",
      reason: enumValue(dataValue(outcome, "reason"), noEvidenceReasons),
      authority: authorityState(
        dataValue(outcome, "authority"),
        noEvidenceAuthorityStates,
      ),
    });
  }
  return dispatchObservationFailure("projection_failed");
}

function observationRecord(
  candidate: StartupGatedAttemptDispatchResult,
): ObservationRecord {
  const result = plainFrozenRecord(candidate);
  const state = dataValue(result, "state");
  if (state === "idle") return Object.freeze(base("idle"));
  if (state === "rejected") return rejectedObservation(result);
  if (state === "indeterminate") return indeterminateObservation(result);
  if (state === "retired") return retiredObservation(result);
  if (state === "completed") return completedObservation(result);
  if (state === "settled") return settledObservation(result);
  return dispatchObservationFailure("projection_failed");
}

export function encodeDispatchObservationRecord(
  record: ObservationRecord,
): Uint8Array {
  try {
    const bytes = encoder.encode(`${canonicalJson(record)}\n`);
    if (bytes.byteLength > maximumLocalRunnerDispatchObservationBytes) {
      return dispatchObservationFailure("projection_failed");
    }
    return bytes;
  } catch {
    return dispatchObservationFailure("projection_failed");
  }
}

export function projectDispatchObservation(
  result: StartupGatedAttemptDispatchResult,
): Uint8Array {
  try {
    return encodeDispatchObservationRecord(observationRecord(result));
  } catch {
    return dispatchObservationFailure("projection_failed");
  }
}

export function createDispatchObservationCore(
  sink: DispatchObservationByteSink,
): DispatchObservationCore {
  const observe = async (
    result: StartupGatedAttemptDispatchResult,
  ): Promise<void> => {
    const bytes = projectDispatchObservation(result);
    try {
      await sink.write(bytes);
    } catch {
      return dispatchObservationFailure("write_failed");
    }
  };
  return Object.freeze({ observe });
}
