export type BudgetLimit = {
  maximumExperiments: number;
  maximumDurationMs: number;
  maximumCostMinor: number;
};

export type BudgetUsage = {
  experiments: number;
  durationMs: number;
  costMinor: number;
};

export type BudgetDimension = "experiments" | "duration" | "cost";

export type BudgetEvaluation = {
  allowed: boolean;
  exhausted: readonly BudgetDimension[];
  projected: BudgetUsage;
};

function assertSafeNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
}

function validateUsage(usage: BudgetUsage, label: string): void {
  assertSafeNonNegativeInteger(usage.experiments, `${label} experiments`);
  assertSafeNonNegativeInteger(usage.durationMs, `${label} duration`);
  assertSafeNonNegativeInteger(usage.costMinor, `${label} cost`);
}

function validateLimit(limit: BudgetLimit): void {
  assertSafeNonNegativeInteger(limit.maximumExperiments, "Maximum experiments");
  assertSafeNonNegativeInteger(limit.maximumDurationMs, "Maximum duration");
  assertSafeNonNegativeInteger(limit.maximumCostMinor, "Maximum cost");

  if (limit.maximumExperiments === 0 || limit.maximumDurationMs === 0) {
    throw new Error(
      "Experiment and duration limits must be greater than zero.",
    );
  }
}

export function evaluateBudget(
  limit: BudgetLimit,
  current: BudgetUsage,
  proposed: BudgetUsage,
): BudgetEvaluation {
  validateLimit(limit);
  validateUsage(current, "Current");
  validateUsage(proposed, "Proposed");

  const projected = {
    experiments: current.experiments + proposed.experiments,
    durationMs: current.durationMs + proposed.durationMs,
    costMinor: current.costMinor + proposed.costMinor,
  };

  validateUsage(projected, "Projected");

  const exhausted: BudgetDimension[] = [];

  if (projected.experiments > limit.maximumExperiments) {
    exhausted.push("experiments");
  }

  if (projected.durationMs > limit.maximumDurationMs) {
    exhausted.push("duration");
  }

  if (projected.costMinor > limit.maximumCostMinor) {
    exhausted.push("cost");
  }

  return {
    allowed: exhausted.length === 0,
    exhausted,
    projected,
  };
}
