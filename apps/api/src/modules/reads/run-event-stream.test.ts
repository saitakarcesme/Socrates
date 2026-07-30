import { describe, expect, it, vi } from "vitest";

import { RunEventNotifier } from "../../realtime/run-event-notifier";
import {
  acceptsEventStream,
  InvalidEventCursorError,
  resolveEventCursor,
} from "./run-event-stream";

describe("run event stream negotiation", () => {
  it.each([
    ["text/event-stream", true],
    ["application/json, text/event-stream; q=0.9", true],
    ["text/event-stream; q=0", false],
    ["application/json", false],
    [undefined, false],
  ])("matches %s", (accept, expected) => {
    expect(acceptsEventStream(accept)).toBe(expected);
  });

  it("prefers Last-Event-ID over the query cursor", () => {
    expect(resolveEventCursor(10, "42")).toBe(42);
    expect(resolveEventCursor(10, undefined)).toBe(10);
  });

  it.each(["-1", "01", "1.5", "unsafe", "9007199254740992"])(
    "rejects invalid Last-Event-ID %s",
    (value) => {
      expect(() => resolveEventCursor(0, value)).toThrow(
        InvalidEventCursorError,
      );
    },
  );
});

describe("RunEventNotifier", () => {
  it("wakes only subscribers for the committed run", async () => {
    vi.useFakeTimers();
    const notifier = new RunEventNotifier();
    const controller = new AbortController();
    let resolved = false;
    const waiting = notifier
      .wait("run-a", 1_000, controller.signal)
      .then(() => {
        resolved = true;
      });

    notifier.publish("run-b");
    await Promise.resolve();
    expect(resolved).toBe(false);

    notifier.publish("run-a");
    await waiting;
    expect(resolved).toBe(true);
    vi.useRealTimers();
  });

  it("releases a wait when the stream aborts", async () => {
    vi.useFakeTimers();
    const notifier = new RunEventNotifier();
    const controller = new AbortController();
    const waiting = notifier.wait("run-a", 1_000, controller.signal);

    controller.abort();
    await expect(waiting).resolves.toBeUndefined();
    vi.useRealTimers();
  });
});
