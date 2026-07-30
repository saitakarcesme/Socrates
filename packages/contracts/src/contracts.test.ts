import { describe, expect, it } from "vitest";

import {
  canonicalDecimalSchema,
  createProjectCommandSchema,
  experimentTaskV1Schema,
} from "./index";

describe("canonical decimal contract", () => {
  it.each(["0", "1", "-0.1", "9007199254740993.01"])("accepts %s", (value) => {
    expect(canonicalDecimalSchema.safeParse(value).success).toBe(true);
  });

  it.each(["-0", "01", "1.0", ".1", "1e3"])("rejects %s", (value) => {
    expect(canonicalDecimalSchema.safeParse(value).success).toBe(false);
  });
});

describe("project command contract", () => {
  const validCommand = {
    name: "Atlas Web",
    objective: "Reduce p75 LCP without regressing conversion.",
    source: {
      type: "website" as const,
      reference: "https://example.com",
    },
    metric: {
      name: "p75 LCP",
      unit: "s",
      direction: "minimize" as const,
      minimumImprovement: "0.05",
      noiseTolerance: "0.01",
      guardrails: [],
    },
  };

  it("accepts a complete command", () => {
    expect(createProjectCommandSchema.safeParse(validCommand).success).toBe(
      true,
    );
  });

  it("rejects unknown fields", () => {
    expect(
      createProjectCommandSchema.safeParse({
        ...validCommand,
        unexpected: true,
      }).success,
    ).toBe(false);
  });
});

describe("runner task contract", () => {
  it("requires exact decimal thresholds", () => {
    const result = experimentTaskV1Schema.safeParse({
      version: "1",
      runId: "019c1170-8b7a-7a60-b7f8-f35c85d73742",
      experimentId: "019c1170-8b7a-7a60-b7f8-f35c85d73743",
      hypothesis: "Critical CSS will improve LCP.",
      actionPlan: {
        summary: "Inline critical CSS.",
        capabilities: [],
      },
      metric: {
        definitionId: "019c1170-8b7a-7a60-b7f8-f35c85d73744",
        direction: "minimize",
        minimumImprovement: "0.05",
      },
      budget: {
        maximumExperiments: 1,
        maximumDurationMs: 300_000,
        maximumCostMinor: 200,
      },
    });

    expect(result.success).toBe(true);
  });
});
