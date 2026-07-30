export type ExperimentStatus =
  | "proposed"
  | "queued"
  | "executing"
  | "measuring"
  | "evaluating"
  | "failed"
  | "kept"
  | "discarded"
  | "inconclusive";

const experimentTransitions: Readonly<
  Record<ExperimentStatus, readonly ExperimentStatus[]>
> = {
  proposed: ["queued"],
  queued: ["executing", "failed"],
  executing: ["measuring", "failed"],
  measuring: ["evaluating", "failed"],
  evaluating: ["kept", "discarded", "inconclusive", "failed"],
  failed: [],
  kept: [],
  discarded: [],
  inconclusive: [],
};

export function canTransitionExperiment(
  from: ExperimentStatus,
  to: ExperimentStatus,
): boolean {
  return experimentTransitions[from].includes(to);
}

export function assertExperimentTransition(
  from: ExperimentStatus,
  to: ExperimentStatus,
): void {
  if (!canTransitionExperiment(from, to)) {
    throw new Error(`Experiment cannot transition from ${from} to ${to}.`);
  }
}
