import {
  runnerExecutionV1Schema,
  runnerTaskDeliveryV1Schema,
  type RunnerExecutionV1,
} from "@socrates/contracts";
import { z } from "zod";

import { attemptKeyFor } from "../spool/codec";
import type { WorkJournalState } from "./contracts";
import type { TerminalPublicationDisposition } from "./terminal-publication-disposition";

export class TerminalEvidenceConsistencyError extends Error {
  constructor(
    readonly code:
      | "completion_invalid"
      | "disposition_invalid"
      | "execution_invalid"
      | "work_invalid",
  ) {
    super("Terminal evidence consistency validation failed.");
    this.name = "TerminalEvidenceConsistencyError";
  }
}

function fail(code: TerminalEvidenceConsistencyError["code"]): never {
  throw new TerminalEvidenceConsistencyError(code);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function immutableEvidenceSnapshot<T>(value: T): T {
  try {
    return deepFreeze(structuredClone(value));
  } catch {
    return fail("disposition_invalid");
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail("disposition_invalid");
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

function instant(value: unknown): string {
  try {
    return z.iso.datetime().parse(value);
  } catch {
    return fail("work_invalid");
  }
}

export function terminalExecutionSnapshot(
  candidate: unknown,
): RunnerExecutionV1 {
  try {
    return deepFreeze(runnerExecutionV1Schema.parse(candidate));
  } catch {
    return fail("execution_invalid");
  }
}

function activeKeys(state: "claimed" | "execution_started"): string[] {
  return [
    "admittedAt",
    "attemptId",
    "claimedAt",
    "deliveryId",
    ...(state === "execution_started" ? ["executionStartedAt"] : []),
    "state",
    "taskId",
  ];
}

export function terminalActiveWorkSnapshot(
  candidate: unknown,
  execution: RunnerExecutionV1,
): WorkJournalState {
  const value = record(immutableEvidenceSnapshot(candidate));
  const state = value["state"];
  if (state !== "claimed" && state !== "execution_started") {
    return fail("work_invalid");
  }
  if (!exactKeys(value, activeKeys(state))) return fail("work_invalid");

  let delivery;
  try {
    delivery = runnerTaskDeliveryV1Schema.parse({
      version: "1",
      deliveryId: value["deliveryId"],
      taskId: value["taskId"],
    });
  } catch {
    return fail("work_invalid");
  }
  if (
    delivery.taskId !== execution.lease.taskId ||
    value["attemptId"] !== execution.lease.attemptId
  ) {
    return fail("work_invalid");
  }
  const work = {
    deliveryId: delivery.deliveryId,
    taskId: delivery.taskId,
    attemptId: execution.lease.attemptId,
    state,
    admittedAt: instant(value["admittedAt"]),
    claimedAt: instant(value["claimedAt"]),
    ...(state === "execution_started"
      ? { executionStartedAt: instant(value["executionStartedAt"]) }
      : {}),
  } satisfies WorkJournalState;
  return deepFreeze(work);
}

function sameActiveWork(
  baseline: WorkJournalState,
  observed: WorkJournalState,
): boolean {
  return (
    observed.deliveryId === baseline.deliveryId &&
    observed.taskId === baseline.taskId &&
    observed.attemptId === baseline.attemptId &&
    observed.state === baseline.state &&
    observed.admittedAt === baseline.admittedAt &&
    observed.claimedAt === baseline.claimedAt &&
    observed.executionStartedAt === baseline.executionStartedAt
  );
}

function safeCounter(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

export function terminalCompletedWorkSnapshot(
  candidate: unknown,
  baseline: WorkJournalState,
  execution: RunnerExecutionV1,
  acknowledgedSequence: number,
): WorkJournalState {
  const value = record(immutableEvidenceSnapshot(candidate));
  const expected = [
    ...activeKeys(
      baseline.state === "execution_started" ? "execution_started" : "claimed",
    ).filter((key) => key !== "state"),
    "completedAt",
    "completion",
    "state",
  ];
  if (value["state"] !== "completed" || !exactKeys(value, expected)) {
    return fail("completion_invalid");
  }
  const completion = record(value["completion"]);
  if (
    !exactKeys(completion, ["acknowledgedSequence", "attemptKey"]) ||
    completion["attemptKey"] !== attemptKeyFor(execution) ||
    completion["acknowledgedSequence"] !== acknowledgedSequence ||
    !safeCounter(acknowledgedSequence) ||
    acknowledgedSequence < 1
  ) {
    return fail("completion_invalid");
  }
  const activeCandidate = {
    ...value,
    state: baseline.state,
  } as Record<string, unknown>;
  delete activeCandidate["completedAt"];
  delete activeCandidate["completion"];
  const active = terminalActiveWorkSnapshot(activeCandidate, execution);
  if (!sameActiveWork(baseline, active)) return fail("completion_invalid");
  return deepFreeze({
    ...active,
    state: "completed",
    completedAt: instant(value["completedAt"]),
    completion: {
      attemptKey: completion["attemptKey"],
      acknowledgedSequence,
    },
  });
}

function cursor(
  value: Record<string, unknown>,
  state: "acknowledged" | "completed" | "pending",
): Readonly<{
  acknowledgedSequence: number;
  lastSequence: number;
  pendingEvents: number;
}> {
  const acknowledgedSequence = value["acknowledgedSequence"];
  const lastSequence = value["lastSequence"];
  const pendingEvents = value["pendingEvents"];
  if (
    !safeCounter(acknowledgedSequence) ||
    !safeCounter(lastSequence) ||
    !safeCounter(pendingEvents) ||
    lastSequence < 1 ||
    acknowledgedSequence > lastSequence ||
    pendingEvents !== lastSequence - acknowledgedSequence ||
    (state === "pending" ? pendingEvents < 1 : pendingEvents !== 0)
  ) {
    return fail("disposition_invalid");
  }
  return Object.freeze({ acknowledgedSequence, lastSequence, pendingEvents });
}

export function terminalDispositionSnapshot(
  candidate: unknown,
  baseline: WorkJournalState,
  execution: RunnerExecutionV1,
): TerminalPublicationDisposition {
  const value = record(immutableEvidenceSnapshot(candidate));
  const state = value["state"];
  if (state === "absent") {
    if (!exactKeys(value, ["state", "work"])) {
      return fail("disposition_invalid");
    }
    const work = terminalActiveWorkSnapshot(value["work"], execution);
    if (!sameActiveWork(baseline, work)) return fail("disposition_invalid");
    return deepFreeze({ state, work });
  }
  if (
    state !== "pending" &&
    state !== "acknowledged" &&
    state !== "completed"
  ) {
    return fail("disposition_invalid");
  }
  if (
    !exactKeys(value, [
      "acknowledgedSequence",
      "lastSequence",
      "pendingEvents",
      "state",
      "work",
    ])
  ) {
    return fail("disposition_invalid");
  }
  const counters = cursor(value, state);
  if (state === "completed") {
    const work = terminalCompletedWorkSnapshot(
      value["work"],
      baseline,
      execution,
      counters.acknowledgedSequence,
    );
    return deepFreeze({ state, work, ...counters });
  }
  const work = terminalActiveWorkSnapshot(value["work"], execution);
  if (!sameActiveWork(baseline, work)) return fail("disposition_invalid");
  return deepFreeze({ state, work, ...counters });
}

export function sameCompletedWork(
  left: WorkJournalState,
  right: WorkJournalState,
): boolean {
  return (
    left.deliveryId === right.deliveryId &&
    left.taskId === right.taskId &&
    left.attemptId === right.attemptId &&
    left.state === "completed" &&
    right.state === "completed" &&
    left.admittedAt === right.admittedAt &&
    left.claimedAt === right.claimedAt &&
    left.executionStartedAt === right.executionStartedAt &&
    left.completedAt === right.completedAt &&
    left.completion?.attemptKey === right.completion?.attemptKey &&
    left.completion?.acknowledgedSequence ===
      right.completion?.acknowledgedSequence
  );
}
