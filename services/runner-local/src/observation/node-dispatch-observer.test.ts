import { describe, expect, it, vi } from "vitest";

import type { StartupGatedAttemptDispatchResult } from "../session";
import {
  NodeLocalRunnerDispatchObservationError,
  NodeLocalRunnerDispatchObserver,
} from "./index";

const idle = Object.freeze({
  state: "idle" as const,
}) satisfies StartupGatedAttemptDispatchResult;

function stderrImplementation(
  callbackError?: Error,
): typeof process.stderr.write {
  return ((_bytes: Uint8Array, callback: (error?: Error | null) => void) => {
    callback(callbackError);
    return true;
  }) as typeof process.stderr.write;
}

describe("NodeLocalRunnerDispatchObserver", () => {
  it("constructs silently with one frozen minimal public capability", async () => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(stderrImplementation());
    const stdout = vi.spyOn(process.stdout, "write");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const observer = new NodeLocalRunnerDispatchObserver();

    expect(stderr).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(Object.isFrozen(observer)).toBe(true);
    expect(Reflect.ownKeys(observer)).toEqual([]);
    await observer.observe(idle);
    expect(stderr).toHaveBeenCalledTimes(1);
    const bytes = stderr.mock.calls[0]![0] as Uint8Array;
    expect(new TextDecoder().decode(bytes)).toBe(
      '{"schema":"socrates.local-runner.dispatch-observation.v1","state":"idle"}\n',
    );
    expect(stdout).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();

    stderr.mockRestore();
    stdout.mockRestore();
    log.mockRestore();
    error.mockRestore();
  });

  it("rejects malformed direct use before stderr access", async () => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(stderrImplementation());
    const observer = new NodeLocalRunnerDispatchObserver();

    const failure = await observer
      .observe({ state: "private" } as StartupGatedAttemptDispatchResult)
      .catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(NodeLocalRunnerDispatchObservationError);
    expect(failure).toMatchObject({ code: "projection_failed" });
    expect(stderr).not.toHaveBeenCalled();
    stderr.mockRestore();
  });

  it("normalizes the stderr callback error without its cause", async () => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(
        stderrImplementation(new Error("private stderr payload")),
      );
    const observer = new NodeLocalRunnerDispatchObserver();

    const failure = await observer
      .observe(idle)
      .catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(NodeLocalRunnerDispatchObservationError);
    expect(failure).toMatchObject({ code: "write_failed" });
    expect("cause" in (failure as object)).toBe(false);
    expect(JSON.stringify(failure)).not.toMatch(/private|stderr|payload/u);
    expect(stderr).toHaveBeenCalledTimes(1);
    stderr.mockRestore();
  });

  it("awaits the captured write callback before observation settles", async () => {
    let callback: ((error?: Error | null) => void) | undefined;
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(((
      _bytes: Uint8Array,
      settled: (error?: Error | null) => void,
    ) => {
      callback = settled;
      return false;
    }) as typeof process.stderr.write);
    const observer = new NodeLocalRunnerDispatchObserver();
    let complete = false;
    const operation = observer.observe(idle).then(() => {
      complete = true;
    });

    await Promise.resolve();
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(complete).toBe(false);
    callback?.();
    await operation;
    expect(complete).toBe(true);
    stderr.mockRestore();
  });

  it("retains the construction-time stderr capability after mutation", async () => {
    const original = process.stderr.write;
    const captured = vi.fn(stderrImplementation());
    const replacement = vi.fn(stderrImplementation());
    try {
      process.stderr.write = captured as typeof process.stderr.write;
      const observer = new NodeLocalRunnerDispatchObserver();
      process.stderr.write = replacement as typeof process.stderr.write;

      await observer.observe(idle);
      expect(captured).toHaveBeenCalledTimes(1);
      expect(replacement).not.toHaveBeenCalled();
    } finally {
      process.stderr.write = original;
    }
  });
});
