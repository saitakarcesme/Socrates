import type { ExperimentDecision, MetricDirection } from "@socrates/contracts";

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

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return runTransitions[from].includes(to);
}

export type DecisionInput = {
  direction: MetricDirection;
  before: number;
  after: number;
  minimumImprovement: number;
  guardrailsPassed: boolean;
  measurementValid: boolean;
};

export type DecisionResult = {
  decision: ExperimentDecision;
  improvement: number;
  reason:
    "improved" | "below_threshold" | "guardrail_failed" | "invalid_measurement";
};

export function decideExperiment(input: DecisionInput): DecisionResult {
  const improvement =
    input.direction === "maximize"
      ? input.after - input.before
      : input.before - input.after;

  if (!input.measurementValid) {
    return {
      decision: "inconclusive",
      improvement,
      reason: "invalid_measurement",
    };
  }

  if (!input.guardrailsPassed) {
    return {
      decision: "discarded",
      improvement,
      reason: "guardrail_failed",
    };
  }

  if (improvement < input.minimumImprovement) {
    return {
      decision: "discarded",
      improvement,
      reason: "below_threshold",
    };
  }

  return { decision: "kept", improvement, reason: "improved" };
}
