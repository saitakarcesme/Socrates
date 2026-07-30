import { describe, expect, it } from "vitest";

import {
  assertExperimentTransition,
  canTransitionExperiment,
} from "./experiment";
import { assertRunTransition, canTransitionRun } from "./run";

describe("run lifecycle", () => {
  it.each([
    ["draft", "queued"],
    ["queued", "preparing"],
    ["preparing", "running"],
    ["running", "paused"],
    ["paused", "running"],
    ["running", "completed"],
  ] as const)("allows %s -> %s", (from, to) => {
    expect(canTransitionRun(from, to)).toBe(true);
    expect(() => assertRunTransition(from, to)).not.toThrow();
  });

  it("keeps terminal states terminal", () => {
    expect(canTransitionRun("completed", "running")).toBe(false);
    expect(() => assertRunTransition("cancelled", "running")).toThrow(
      "Run cannot transition",
    );
  });
});

describe("experiment lifecycle", () => {
  it.each([
    ["proposed", "queued"],
    ["queued", "executing"],
    ["executing", "measuring"],
    ["measuring", "evaluating"],
    ["evaluating", "kept"],
    ["evaluating", "discarded"],
    ["evaluating", "inconclusive"],
  ] as const)("allows %s -> %s", (from, to) => {
    expect(canTransitionExperiment(from, to)).toBe(true);
  });

  it("rejects decisions before evaluation", () => {
    expect(canTransitionExperiment("executing", "kept")).toBe(false);
    expect(() => assertExperimentTransition("proposed", "kept")).toThrow(
      "Experiment cannot transition",
    );
  });
});
