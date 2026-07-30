import type { ExperimentDetailResource } from "@socrates/contracts";
import { describe, expect, it } from "vitest";

import { selectBestMetric } from "./metric-presentation";

function experiment(amount: string, unit = "s"): ExperimentDetailResource {
  return {
    id: crypto.randomUUID(),
    runId: crypto.randomUUID(),
    parentExperimentId: null,
    sequence: 1,
    hypothesis: "Test an exact metric.",
    action: "Measure it.",
    status: "kept",
    version: 1,
    estimatedDurationMs: 1,
    estimatedCostMinor: 0,
    startedAt: null,
    completedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    observations: [
      {
        id: crypto.randomUUID(),
        kind: "after",
        metricDefinitionId: crypto.randomUUID(),
        constraintDefinitionId: null,
        value: { amount, unit },
        sampleCount: 1,
        notes: null,
        recordedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    decision: null,
    learnings: [],
  };
}

describe("metric presentation", () => {
  it("selects the exact minimum across different decimal scales", () => {
    expect(
      selectBestMetric(
        { amount: "2.40", unit: "s" },
        [experiment("2.399999999999999999"), experiment("2.4")],
        "minimize",
      ),
    ).toEqual({ amount: "2.399999999999999999", unit: "s" });
  });

  it("selects the exact maximum without converting to Number", () => {
    expect(
      selectBestMetric(
        { amount: "9007199254740992", unit: "points" },
        [experiment("9007199254740993", "points")],
        "maximize",
      ),
    ).toEqual({ amount: "9007199254740993", unit: "points" });
  });
});
