import { describe, expect, it } from "vitest";

import { runnerEventDraft } from "./draft";

describe("runner event draft", () => {
  it("validates and freezes only V2 type and payload fields", () => {
    const draft = runnerEventDraft({
      type: "workspace.prepared",
      payload: {
        sourceDigest: `sha256:${"a".repeat(64)}`,
        imageDigest: `sha256:${"b".repeat(64)}`,
      },
    });

    expect(draft).toEqual({
      type: "workspace.prepared",
      payload: {
        sourceDigest: `sha256:${"a".repeat(64)}`,
        imageDigest: `sha256:${"b".repeat(64)}`,
      },
    });
    expect(Object.isFrozen(draft)).toBe(true);
    expect(Object.isFrozen(draft.payload)).toBe(true);
    expect(draft).not.toHaveProperty("eventId");
    expect(draft).not.toHaveProperty("sequence");
    expect(draft).not.toHaveProperty("occurredAt");
  });

  it("rejects payloads that do not match their event type", () => {
    expect(() =>
      runnerEventDraft({
        type: "action.started",
        payload: { commandIndex: -1 },
      }),
    ).toThrow();
  });
});
