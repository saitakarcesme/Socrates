import { describe, expect, it } from "vitest";

import { redactRunnerEvent } from "./runner-evidence";

const envelope = {
  version: "2" as const,
  eventId: "10000000-0000-4000-8000-000000000001",
  runnerId: "10000000-0000-4000-8000-000000000002",
  taskId: "10000000-0000-4000-8000-000000000003",
  attemptId: "10000000-0000-4000-8000-000000000004",
  fence: 1,
  sequence: 1,
  occurredAt: "2026-07-31T00:00:00.000Z",
};

describe("runner log redaction", () => {
  it("redacts common credential shapes and recomputes UTF-8 bytes", () => {
    const text =
      "Authorization: Bearer abcdefghijklmnop\napi_key=sk-secretvalue123\nAKIAABCDEFGHIJKLMNOP";

    const event = redactRunnerEvent({
      ...envelope,
      type: "log.appended",
      payload: {
        stream: "stderr",
        text,
        utf8Bytes: new TextEncoder().encode(text).byteLength,
        redacted: false,
      },
    });

    expect(event.payload).toEqual({
      stream: "stderr",
      text: [
        "Authorization: Bearer [REDACTED]",
        "api_key=[REDACTED]",
        "[REDACTED]",
      ].join("\n"),
      utf8Bytes: 62,
      redacted: true,
    });
  });

  it("preserves markup as inert text", () => {
    const text = `<script>alert("not executable")</script>`;

    const event = redactRunnerEvent({
      ...envelope,
      type: "log.appended",
      payload: {
        stream: "stdout",
        text,
        utf8Bytes: text.length,
        redacted: true,
      },
    });

    expect(event.type).toBe("log.appended");
    if (event.type !== "log.appended") {
      throw new Error("Expected a log event.");
    }
    expect(event.payload.text).toBe(text);
  });
});
