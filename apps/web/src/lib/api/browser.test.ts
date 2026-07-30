import { describe, expect, it } from "vitest";

import { runEventStreamUrl } from "./browser";

describe("browser control-plane transport", () => {
  it("uses the same-origin stream URL and encodes identifiers", () => {
    expect(runEventStreamUrl("run/id", 42)).toBe(
      "/control-plane/v1/runs/run%2Fid/events?after=42",
    );
  });
});
