import { describe, expect, it } from "vitest";

import { evaluateBudget, type BudgetLimit } from "./budget";

const limit: BudgetLimit = {
  maximumExperiments: 12,
  maximumDurationMs: 7_200_000,
  maximumCostMinor: 1_200,
};

describe("evaluateBudget", () => {
  it("allows projected usage exactly at every limit", () => {
    expect(
      evaluateBudget(
        limit,
        { experiments: 11, durationMs: 7_000_000, costMinor: 1_000 },
        { experiments: 1, durationMs: 200_000, costMinor: 200 },
      ),
    ).toEqual({
      allowed: true,
      exhausted: [],
      projected: {
        experiments: 12,
        durationMs: 7_200_000,
        costMinor: 1_200,
      },
    });
  });

  it("reports every exceeded dimension", () => {
    expect(
      evaluateBudget(
        limit,
        { experiments: 12, durationMs: 7_100_000, costMinor: 1_150 },
        { experiments: 1, durationMs: 200_000, costMinor: 100 },
      ),
    ).toMatchObject({
      allowed: false,
      exhausted: ["experiments", "duration", "cost"],
    });
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid usage %s",
    (experiments) => {
      expect(() =>
        evaluateBudget(
          limit,
          { experiments, durationMs: 0, costMinor: 0 },
          { experiments: 0, durationMs: 0, costMinor: 0 },
        ),
      ).toThrow("safe integer");
    },
  );
});
