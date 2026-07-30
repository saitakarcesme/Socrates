import { describe, expect, it } from "vitest";

import {
  applyDecisionOverride,
  decideExperiment,
  DecisionOverrideError,
  evaluateConstraint,
  MetricProtocolError,
  type DecisionInput,
} from "./metric";

function input(overrides: Partial<DecisionInput> = {}): DecisionInput {
  return {
    protocol: {
      direction: "minimize",
      unit: "s",
      minimumImprovement: "0.05",
      noiseTolerance: "0.01",
    },
    before: { amount: "2.42", unit: "s" },
    after: { amount: "2.31", unit: "s" },
    guardrailsPassed: true,
    measurementValid: true,
    ...overrides,
  };
}

describe("decideExperiment", () => {
  it("keeps a minimizing result that clears threshold and noise", () => {
    expect(decideExperiment(input())).toEqual({
      decision: "kept",
      improvement: "0.11",
      reason: "improved",
    });
  });

  it("calculates maximizing improvement exactly", () => {
    expect(
      decideExperiment(
        input({
          protocol: {
            direction: "maximize",
            unit: "%",
            minimumImprovement: "2",
            noiseTolerance: "0.1",
          },
          before: { amount: "55.3", unit: "%" },
          after: { amount: "63.4", unit: "%" },
        }),
      ),
    ).toMatchObject({ decision: "kept", improvement: "8.1" });
  });

  it("marks changes inside noise tolerance inconclusive", () => {
    expect(
      decideExperiment(
        input({
          before: { amount: "1", unit: "s" },
          after: { amount: "0.995", unit: "s" },
        }),
      ),
    ).toMatchObject({
      decision: "inconclusive",
      improvement: "0.005",
      reason: "within_noise",
    });
  });

  it("discards valid improvement below the acceptance threshold", () => {
    expect(
      decideExperiment(
        input({
          before: { amount: "1", unit: "s" },
          after: { amount: "0.97", unit: "s" },
        }),
      ),
    ).toMatchObject({
      decision: "discarded",
      improvement: "0.03",
      reason: "below_threshold",
    });
  });

  it("prioritizes measurement and guardrail validity", () => {
    expect(decideExperiment(input({ measurementValid: false }))).toMatchObject({
      decision: "inconclusive",
      reason: "invalid_measurement",
    });
    expect(decideExperiment(input({ guardrailsPassed: false }))).toMatchObject({
      decision: "discarded",
      reason: "guardrail_failed",
    });
  });

  it("marks missing primary evidence inconclusive", () => {
    expect(decideExperiment(input({ before: null }))).toEqual({
      decision: "inconclusive",
      improvement: "0",
      reason: "invalid_measurement",
    });
  });

  it("rejects units that do not match the protocol", () => {
    expect(() =>
      decideExperiment(input({ after: { amount: "2.31", unit: "ms" } })),
    ).toThrowError(MetricProtocolError);
  });

  it.each([
    ["minimumImprovement", "-0.1", "negative_minimum_improvement"],
    ["noiseTolerance", "-0.1", "negative_noise_tolerance"],
  ] as const)("rejects negative %s", (field, value, expectedCode) => {
    try {
      decideExperiment(
        input({
          protocol: {
            ...input().protocol,
            [field]: value,
          },
        }),
      );
      throw new Error("Expected decision policy to reject the protocol.");
    } catch (error) {
      expect(error).toBeInstanceOf(MetricProtocolError);
      expect((error as MetricProtocolError).code).toBe(expectedCode);
    }
  });
});

describe("applyDecisionOverride", () => {
  it("preserves a distinct final decision and its reason", () => {
    expect(
      applyDecisionOverride(
        { decision: "kept", improvement: "0.2", reason: "improved" },
        {
          decision: "discarded",
          reason: "The improvement does not justify the operational cost.",
        },
      ),
    ).toEqual({
      finalDecision: "discarded",
      overrideReason: "The improvement does not justify the operational cost.",
    });
  });

  it.each(["guardrail_failed", "invalid_measurement"] as const)(
    "rejects a kept result when evidence is %s",
    (reason) => {
      expect(() =>
        applyDecisionOverride(
          { decision: "discarded", improvement: "0.2", reason },
          { decision: "kept", reason: "Accept anyway." },
        ),
      ).toThrow(DecisionOverrideError);
    },
  );

  it("does not record a reason when the final decision is unchanged", () => {
    expect(
      applyDecisionOverride(
        { decision: "inconclusive", improvement: "0", reason: "within_noise" },
        { decision: "inconclusive", reason: "Operator agrees." },
      ),
    ).toEqual({ finalDecision: "inconclusive", overrideReason: null });
  });
});

describe("evaluateConstraint", () => {
  it.each([
    ["less_than", "1.9", "2", true],
    ["less_than", "2", "2", false],
    ["less_than_or_equal", "2", "2", true],
    ["greater_than", "2.1", "2", true],
    ["greater_than", "2", "2", false],
    ["greater_than_or_equal", "2", "2", true],
  ] as const)(
    "evaluates %s exactly for %s against %s",
    (operator, observed, threshold, expected) => {
      expect(
        evaluateConstraint({
          operator,
          observed: { amount: observed, unit: "s" },
          threshold: { amount: threshold, unit: "s" },
        }),
      ).toBe(expected);
    },
  );

  it("rejects unit mismatches", () => {
    expect(() =>
      evaluateConstraint({
        operator: "less_than",
        observed: { amount: "2", unit: "ms" },
        threshold: { amount: "2", unit: "s" },
      }),
    ).toThrow(MetricProtocolError);
  });
});
