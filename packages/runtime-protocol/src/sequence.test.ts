import { describe, expect, it } from "vitest";

import {
  RuntimeFrameSequenceError,
  RuntimeFrameSequenceValidator,
} from "./sequence";

describe("runtime frame sequence", () => {
  it("accepts one ordered action, measurement, and successful terminal", () => {
    const sequence = new RuntimeFrameSequenceValidator({
      mode: "execution",
      actionCount: 1,
    });
    sequence.accept({
      type: "command.started",
      phase: "action",
      commandIndex: 0,
    });
    sequence.accept({
      type: "command.output",
      phase: "action",
      commandIndex: 0,
      stream: "stdout",
      sequence: 0,
      bytes: "b2s=",
    });
    sequence.accept({
      type: "command.exited",
      phase: "action",
      commandIndex: 0,
      exitCode: 0,
      signal: null,
      durationMs: 1,
    });
    sequence.accept({
      type: "command.started",
      phase: "measurement",
      commandIndex: 0,
    });
    sequence.accept({
      type: "command.exited",
      phase: "measurement",
      commandIndex: 0,
      exitCode: 0,
      signal: null,
      durationMs: 1,
    });
    sequence.accept({ type: "measurement.result", bytes: "e30=" });
    sequence.accept({ type: "runtime.completed", status: "succeeded" });

    expect(() => sequence.finish()).not.toThrow();
  });

  it("rejects gaps, wrong command order, and output after completion", () => {
    const sequence = new RuntimeFrameSequenceValidator({
      mode: "execution",
      actionCount: 1,
    });
    expect(() =>
      sequence.accept({
        type: "command.started",
        phase: "measurement",
        commandIndex: 0,
      }),
    ).toThrow(RuntimeFrameSequenceError);

    const output = new RuntimeFrameSequenceValidator({
      mode: "execution",
      actionCount: 1,
    });
    output.accept({
      type: "command.started",
      phase: "action",
      commandIndex: 0,
    });
    expect(() =>
      output.accept({
        type: "command.output",
        phase: "action",
        commandIndex: 0,
        stream: "stderr",
        sequence: 1,
        bytes: "",
      }),
    ).toThrow(RuntimeFrameSequenceError);
  });

  it("requires exactly one handshake frame in handshake mode", () => {
    const handshake = new RuntimeFrameSequenceValidator({ mode: "handshake" });
    handshake.accept({
      type: "runtime.handshake",
      abi: "socrates.task-runtime.v1",
      buildDigest: `sha256:${"a".repeat(64)}`,
    });
    expect(() => handshake.finish()).not.toThrow();
    expect(() =>
      handshake.accept({
        type: "runtime.handshake",
        abi: "socrates.task-runtime.v1",
        buildDigest: `sha256:${"a".repeat(64)}`,
      }),
    ).toThrow(RuntimeFrameSequenceError);
  });
});
