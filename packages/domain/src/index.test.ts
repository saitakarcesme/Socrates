import { describe, expect, it } from "vitest";

import { canTransitionRun, decideExperiment } from "./index";

describe("run transitions", () => {
  it("allows explicit progress and rejects terminal transitions", () => {
    expect(canTransitionRun("draft", "queued")).toBe(true);
    expect(canTransitionRun("completed", "running")).toBe(false);
  });
});

describe("experiment decisions", () => {
  it("keeps a minimizing result that clears the threshold", () => {
    expect(
      decideExperiment({
        direction: "minimize",
        before: 2.42,
        after: 2.31,
        minimumImprovement: 0.05,
        guardrailsPassed: true,
        measurementValid: true,
      }),
    ).toMatchObject({ decision: "kept", reason: "improved" });
  });

  it("marks invalid measurements inconclusive", () => {
    expect(
      decideExperiment({
        direction: "maximize",
        before: 10,
        after: 20,
        minimumImprovement: 1,
        guardrailsPassed: true,
        measurementValid: false,
      }),
    ).toMatchObject({
      decision: "inconclusive",
      reason: "invalid_measurement",
    });
  });
});
