import { describe, expect, it } from "vitest";

import { summarizeLatency } from "./statistics";

describe("OCI spike statistics", () => {
  it("reports deterministic nearest-rank latency statistics", () => {
    expect(summarizeLatency([40, 10, 20, 30, 50])).toEqual({
      samples: 5,
      medianMs: 30,
      p95Ms: 50,
      maximumMs: 50,
    });
  });

  it("rejects an empty measurement set", () => {
    expect(() => summarizeLatency([])).toThrow(RangeError);
  });
});
