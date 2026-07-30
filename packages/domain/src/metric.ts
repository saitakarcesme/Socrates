import type { ExperimentDecision, MetricDirection } from "@socrates/contracts";

import { DecimalAmount } from "./decimal";

export type MetricValue = {
  amount: string;
  unit: string;
};

export type MetricProtocol = {
  direction: MetricDirection;
  unit: string;
  minimumImprovement: string;
  noiseTolerance: string;
};

export type ConstraintOperator =
  "less_than" | "less_than_or_equal" | "greater_than" | "greater_than_or_equal";

export type DecisionInput = {
  protocol: MetricProtocol;
  before: MetricValue | null;
  after: MetricValue | null;
  guardrailsPassed: boolean;
  measurementValid: boolean;
};

export type DecisionReason =
  | "improved"
  | "within_noise"
  | "below_threshold"
  | "guardrail_failed"
  | "invalid_measurement";

export type DecisionResult = {
  decision: ExperimentDecision;
  improvement: string;
  reason: DecisionReason;
};

export class MetricProtocolError extends Error {
  constructor(
    readonly code:
      | "unit_mismatch"
      | "negative_minimum_improvement"
      | "negative_noise_tolerance",
    message: string,
  ) {
    super(message);
    this.name = "MetricProtocolError";
  }
}

function assertProtocolValue(
  value: DecimalAmount,
  code: "negative_minimum_improvement" | "negative_noise_tolerance",
  label: string,
) {
  if (value.compare(DecimalAmount.parse("0")) < 0) {
    throw new MetricProtocolError(code, `${label} must not be negative.`);
  }
}

export function assertMetricUnit(
  expectedUnit: string,
  value: MetricValue,
): void {
  if (value.unit !== expectedUnit) {
    throw new MetricProtocolError(
      "unit_mismatch",
      `Expected ${expectedUnit} for every metric value.`,
    );
  }
}

export function evaluateConstraint(input: {
  operator: ConstraintOperator;
  threshold: MetricValue;
  observed: MetricValue;
}): boolean {
  assertMetricUnit(input.threshold.unit, input.observed);

  const observed = DecimalAmount.parse(input.observed.amount);
  const threshold = DecimalAmount.parse(input.threshold.amount);
  const comparison = observed.compare(threshold);

  switch (input.operator) {
    case "less_than":
      return comparison < 0;
    case "less_than_or_equal":
      return comparison <= 0;
    case "greater_than":
      return comparison > 0;
    case "greater_than_or_equal":
      return comparison >= 0;
  }
}

export function decideExperiment(input: DecisionInput): DecisionResult {
  const { protocol } = input;

  if (!input.before || !input.after) {
    return {
      decision: "inconclusive",
      improvement: "0",
      reason: "invalid_measurement",
    };
  }

  assertMetricUnit(protocol.unit, input.before);
  assertMetricUnit(protocol.unit, input.after);

  const before = DecimalAmount.parse(input.before.amount);
  const after = DecimalAmount.parse(input.after.amount);
  const minimumImprovement = DecimalAmount.parse(protocol.minimumImprovement);
  const noiseTolerance = DecimalAmount.parse(protocol.noiseTolerance);

  assertProtocolValue(
    minimumImprovement,
    "negative_minimum_improvement",
    "Minimum improvement",
  );
  assertProtocolValue(
    noiseTolerance,
    "negative_noise_tolerance",
    "Noise tolerance",
  );

  const improvement =
    protocol.direction === "maximize"
      ? after.subtract(before)
      : before.subtract(after);
  const serializedImprovement = improvement.toString();

  if (!input.measurementValid) {
    return {
      decision: "inconclusive",
      improvement: serializedImprovement,
      reason: "invalid_measurement",
    };
  }

  if (!input.guardrailsPassed) {
    return {
      decision: "discarded",
      improvement: serializedImprovement,
      reason: "guardrail_failed",
    };
  }

  if (improvement.compare(noiseTolerance) <= 0) {
    return {
      decision: "inconclusive",
      improvement: serializedImprovement,
      reason: "within_noise",
    };
  }

  if (improvement.compare(minimumImprovement) < 0) {
    return {
      decision: "discarded",
      improvement: serializedImprovement,
      reason: "below_threshold",
    };
  }

  return {
    decision: "kept",
    improvement: serializedImprovement,
    reason: "improved",
  };
}
