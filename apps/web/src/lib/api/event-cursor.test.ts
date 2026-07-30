import { describe, expect, it } from "vitest";

import { classifyEventSequence } from "./event-cursor";

describe("SSE event cursor", () => {
  it("accepts only the next contiguous durable sequence", () => {
    expect(classifyEventSequence(4, 5)).toBe("next");
  });

  it("suppresses duplicates and detects gaps", () => {
    expect(classifyEventSequence(4, 4)).toBe("duplicate");
    expect(classifyEventSequence(4, 3)).toBe("duplicate");
    expect(classifyEventSequence(4, 6)).toBe("gap");
  });
});
