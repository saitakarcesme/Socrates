export type RunnerTaskStatus =
  | "queued"
  | "leased"
  | "running"
  | "cancellation_requested"
  | "succeeded"
  | "failed"
  | "cancelled";

export type RunnerEventSequenceResult =
  | { kind: "accepted"; acknowledgedSequence: number }
  | { kind: "replay"; expectedSequence: number }
  | { kind: "gap"; expectedSequence: number };

const runnerTaskTransitions: Readonly<
  Record<RunnerTaskStatus, readonly RunnerTaskStatus[]>
> = {
  queued: ["leased", "cancelled"],
  leased: ["queued", "running", "cancellation_requested", "failed"],
  running: ["cancellation_requested", "succeeded", "failed"],
  cancellation_requested: ["succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export class RunnerTaskTransitionError extends Error {
  constructor(
    readonly from: RunnerTaskStatus,
    readonly to: RunnerTaskStatus,
  ) {
    super(`Runner task cannot transition from ${from} to ${to}.`);
    this.name = "RunnerTaskTransitionError";
  }
}

export function canTransitionRunnerTask(
  from: RunnerTaskStatus,
  to: RunnerTaskStatus,
): boolean {
  return runnerTaskTransitions[from].includes(to);
}

export function assertRunnerTaskTransition(
  from: RunnerTaskStatus,
  to: RunnerTaskStatus,
): void {
  if (!canTransitionRunnerTask(from, to)) {
    throw new RunnerTaskTransitionError(from, to);
  }
}

export function classifyRunnerEventSequence(
  lastAcknowledgedSequence: number,
  incomingSequence: number,
): RunnerEventSequenceResult {
  if (
    !Number.isSafeInteger(lastAcknowledgedSequence) ||
    lastAcknowledgedSequence < 0 ||
    lastAcknowledgedSequence >= Number.MAX_SAFE_INTEGER ||
    !Number.isSafeInteger(incomingSequence) ||
    incomingSequence < 1
  ) {
    throw new RangeError("Runner event sequences must be safe integers.");
  }

  const expectedSequence = lastAcknowledgedSequence + 1;
  if (incomingSequence === expectedSequence) {
    return { kind: "accepted", acknowledgedSequence: incomingSequence };
  }
  if (incomingSequence <= lastAcknowledgedSequence) {
    return { kind: "replay", expectedSequence };
  }
  return { kind: "gap", expectedSequence };
}
