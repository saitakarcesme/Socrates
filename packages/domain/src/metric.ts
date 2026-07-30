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

export type DecisionInput = {
  protocol: MetricProtocol;
  before: MetricValue;
  after: MetricValue;
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

export function decideExperiment(input: DecisionInput): DecisionResult {
  const { protocol } = input;

  if (
    input.before.unit !== protocol.unit ||
    input.after.unit !== protocol.unit
  ) {
    throw new MetricProtocolError(
      "unit_mismatch",
      `Expected ${protocol.unit} for every metric value.`,
    );
  }

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
