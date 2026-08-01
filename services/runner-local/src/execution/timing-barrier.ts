import type { TerminalExecutionTiming } from "../lifecycle/outcome-arbiter";
import type { RuntimeExecutionStartBarrier } from "../runtime/executor";

export interface MonotonicTimeSource {
  now(): number;
}

export class DurableExecutionTimingBarrierError extends Error {
  constructor(
    readonly code: "start_uncertain" | "timing_uncertain",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DurableExecutionTimingBarrierError";
  }
}

export class DurableExecutionTimingBarrier implements RuntimeExecutionStartBarrier {
  readonly #barrier: RuntimeExecutionStartBarrier;
  readonly #time: MonotonicTimeSource;
  #operation: Promise<void> | undefined;
  #startedAt: number | undefined;

  constructor(options: {
    barrier: RuntimeExecutionStartBarrier;
    time: MonotonicTimeSource;
  }) {
    this.#barrier = options.barrier;
    this.#time = options.time;
  }

  cross(): Promise<void> {
    this.#operation ??= this.#cross();
    return this.#operation;
  }

  snapshot(): TerminalExecutionTiming {
    if (this.#startedAt === undefined) {
      return Object.freeze({ state: "not_started" });
    }
    const current = this.#read();
    const elapsedMs = Math.ceil(current - this.#startedAt);
    if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 0) {
      throw new DurableExecutionTimingBarrierError(
        "timing_uncertain",
        "Execution elapsed time is not a non-negative safe integer.",
      );
    }
    return Object.freeze({ state: "started", elapsedMs });
  }

  async #cross(): Promise<void> {
    try {
      await this.#barrier.cross();
    } catch (cause) {
      throw new DurableExecutionTimingBarrierError(
        "start_uncertain",
        "Durable execution start is uncertain.",
        { cause },
      );
    }
    this.#startedAt = this.#read();
  }

  #read(): number {
    let value: number;
    try {
      value = this.#time.now();
    } catch (cause) {
      throw new DurableExecutionTimingBarrierError(
        "timing_uncertain",
        "Monotonic execution time is unavailable.",
        { cause },
      );
    }
    if (!Number.isFinite(value) || value < 0) {
      throw new DurableExecutionTimingBarrierError(
        "timing_uncertain",
        "Monotonic execution time is invalid.",
      );
    }
    return value;
  }
}
