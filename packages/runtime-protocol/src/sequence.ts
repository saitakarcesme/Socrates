import type { RuntimeFrame } from "./schema";

type CommandAddress = Readonly<{
  phase: "action" | "measurement";
  commandIndex: number;
}>;

export class RuntimeFrameSequenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeFrameSequenceError";
  }
}

export class RuntimeFrameSequenceValidator {
  readonly #mode: "execution" | "handshake";
  readonly #actionCount: number;
  #handshakeSeen = false;
  #active: CommandAddress | undefined;
  #nextAction = 0;
  #nextOutputSequence = 0;
  #measurementExited = false;
  #nextMeasurementSequence = 0;
  #measurementResultComplete = false;
  #errorSeen = false;
  #completed = false;

  constructor(input: {
    mode: "execution" | "handshake";
    actionCount?: number;
  }) {
    if (
      input.mode === "execution" &&
      (!Number.isSafeInteger(input.actionCount) ||
        (input.actionCount ?? 0) < 1 ||
        (input.actionCount ?? 0) > 64)
    ) {
      throw new RangeError(
        "Execution frame validation requires 1 to 64 actions.",
      );
    }
    this.#mode = input.mode;
    this.#actionCount = input.actionCount ?? 0;
  }

  accept(frame: RuntimeFrame): void {
    if (this.#completed) {
      throw new RuntimeFrameSequenceError(
        "Runtime emitted a frame after completion.",
      );
    }
    if (this.#mode === "handshake") {
      if (frame.type !== "runtime.handshake" || this.#handshakeSeen) {
        throw new RuntimeFrameSequenceError(
          "Handshake mode requires exactly one handshake frame.",
        );
      }
      this.#handshakeSeen = true;
      return;
    }
    if (frame.type === "runtime.handshake") {
      throw new RuntimeFrameSequenceError(
        "Execution mode cannot emit a handshake frame.",
      );
    }

    switch (frame.type) {
      case "command.started": {
        if (this.#active || this.#errorSeen || this.#measurementExited) {
          throw new RuntimeFrameSequenceError(
            "Runtime command started in an invalid state.",
          );
        }
        const expected: CommandAddress =
          this.#nextAction < this.#actionCount
            ? { phase: "action", commandIndex: this.#nextAction }
            : { phase: "measurement", commandIndex: 0 };
        if (
          frame.phase !== expected.phase ||
          frame.commandIndex !== expected.commandIndex
        ) {
          throw new RuntimeFrameSequenceError(
            "Runtime command order does not match the request.",
          );
        }
        this.#active = expected;
        this.#nextOutputSequence = 0;
        break;
      }
      case "command.output": {
        if (
          !this.#active ||
          frame.phase !== this.#active.phase ||
          frame.commandIndex !== this.#active.commandIndex ||
          frame.sequence !== this.#nextOutputSequence
        ) {
          throw new RuntimeFrameSequenceError(
            "Runtime output has an invalid command address or sequence.",
          );
        }
        this.#nextOutputSequence += 1;
        break;
      }
      case "command.exited": {
        if (
          !this.#active ||
          frame.phase !== this.#active.phase ||
          frame.commandIndex !== this.#active.commandIndex
        ) {
          throw new RuntimeFrameSequenceError(
            "Runtime exit does not match the active command.",
          );
        }
        const successful = frame.exitCode === 0 && frame.signal === null;
        if (this.#active.phase === "action" && successful) {
          this.#nextAction += 1;
        } else if (this.#active.phase === "measurement" && successful) {
          this.#measurementExited = true;
        }
        this.#active = undefined;
        break;
      }
      case "measurement.result": {
        if (
          !this.#measurementExited ||
          this.#measurementResultComplete ||
          this.#active ||
          this.#errorSeen ||
          frame.sequence !== this.#nextMeasurementSequence
        ) {
          throw new RuntimeFrameSequenceError(
            "Measurement result arrived in an invalid state.",
          );
        }
        this.#nextMeasurementSequence += 1;
        this.#measurementResultComplete = frame.final;
        break;
      }
      case "runtime.error": {
        if (
          this.#active ||
          this.#errorSeen ||
          this.#nextMeasurementSequence > 0
        ) {
          throw new RuntimeFrameSequenceError(
            "Runtime error arrived in an invalid state.",
          );
        }
        this.#errorSeen = true;
        break;
      }
      case "runtime.completed": {
        const success =
          frame.status === "succeeded" &&
          this.#nextAction === this.#actionCount &&
          this.#measurementExited &&
          this.#measurementResultComplete &&
          !this.#errorSeen &&
          !this.#active;
        const failure =
          frame.status === "failed" && this.#errorSeen && !this.#active;
        if (!success && !failure) {
          throw new RuntimeFrameSequenceError(
            "Runtime completion contradicts the observed frame sequence.",
          );
        }
        this.#completed = true;
        break;
      }
    }
  }

  finish(): void {
    if (
      (this.#mode === "handshake" && !this.#handshakeSeen) ||
      (this.#mode === "execution" && !this.#completed)
    ) {
      throw new RuntimeFrameSequenceError(
        "Runtime frame stream ended before its required terminal frame.",
      );
    }
  }
}
