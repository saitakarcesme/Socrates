export type RunStatus =
  | "draft"
  | "queued"
  | "preparing"
  | "running"
  | "paused"
  | "cancelling"
  | "cancelled"
  | "completed"
  | "failed"
  | "budget_exhausted";

const runTransitions: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  draft: ["queued"],
  queued: ["preparing", "cancelling", "failed"],
  preparing: ["running", "cancelling", "failed"],
  running: ["paused", "cancelling", "completed", "failed", "budget_exhausted"],
  paused: ["running", "cancelling"],
  cancelling: ["cancelled"],
  cancelled: [],
  completed: [],
  failed: [],
  budget_exhausted: [],
};

export class RunTransitionError extends Error {
  constructor(
    readonly from: RunStatus,
    readonly to: RunStatus,
  ) {
    super(`Run cannot transition from ${from} to ${to}.`);
    this.name = "RunTransitionError";
  }
}

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return runTransitions[from].includes(to);
}

export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransitionRun(from, to)) {
    throw new RunTransitionError(from, to);
  }
}
