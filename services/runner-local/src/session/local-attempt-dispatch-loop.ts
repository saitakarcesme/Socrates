import { runnerTaskDeliveryV1Schema } from "@socrates/contracts";

import {
  immutableEvidenceSnapshot,
  terminalExecutionSnapshot,
} from "../work-journal/terminal-evidence-consistency";
import {
  freshSessionResultSnapshot,
  nonSessionAdmissionSnapshot,
  restartSessionResultSnapshot,
  type StartupGatedAttemptDispatchResult,
} from "./startup-gated-attempt-contracts";

const MAXIMUM_NODE_TIMER_DELAY_MS = 2_147_483_647;

export interface LocalAttemptDispatchOwner {
  dispatchNext(
    signal?: AbortSignal,
  ): Promise<StartupGatedAttemptDispatchResult>;
}

export interface LocalAttemptDispatchDelay {
  wait(delayMs: number, signal: AbortSignal): Promise<void>;
}

export interface LocalAttemptDispatchObserver {
  observe(result: StartupGatedAttemptDispatchResult): Promise<void>;
}

export type LocalAttemptDispatchLoopResult = Readonly<{ state: "stopped" }>;

type LocalAttemptDispatchLoopErrorCode =
  | "delay_failed"
  | "dispatch_failed"
  | "invalid_configuration"
  | "invalid_dependency"
  | "invalid_result"
  | "observation_failed";

const errorMessages = Object.freeze({
  delay_failed: "Local attempt dispatch delay failed.",
  dispatch_failed: "Local attempt dispatch failed.",
  invalid_configuration: "Local attempt dispatch configuration is invalid.",
  invalid_dependency: "Local attempt dispatch dependency is invalid.",
  invalid_result: "Local attempt dispatch result is invalid.",
  observation_failed: "Local attempt dispatch observation failed.",
} satisfies Record<LocalAttemptDispatchLoopErrorCode, string>);

export class LocalAttemptDispatchLoopError extends Error {
  constructor(
    readonly code: LocalAttemptDispatchLoopErrorCode,
    options?: ErrorOptions,
  ) {
    super(errorMessages[code], options);
    this.name = "LocalAttemptDispatchLoopError";
    Object.freeze(this);
  }
}

type CapturedDependencies = Readonly<{
  dispatch(signal?: AbortSignal): Promise<StartupGatedAttemptDispatchResult>;
  wait(delayMs: number, signal: AbortSignal): Promise<void>;
  observe(result: StartupGatedAttemptDispatchResult): Promise<void>;
}>;

function method<T extends object, K extends keyof T>(owner: T, name: K): T[K] {
  try {
    const candidate = owner[name];
    if (typeof candidate !== "function") throw new TypeError("Not a function.");
    return candidate.bind(owner) as T[K];
  } catch (cause) {
    throw new LocalAttemptDispatchLoopError("invalid_dependency", { cause });
  }
}

function capture(options: {
  owner: LocalAttemptDispatchOwner;
  delay: LocalAttemptDispatchDelay;
  observer: LocalAttemptDispatchObserver;
}): CapturedDependencies {
  return Object.freeze({
    dispatch: method(options.owner, "dispatchNext"),
    wait: method(options.delay, "wait"),
    observe: method(options.observer, "observe"),
  });
}

function record(candidate: unknown): Record<string, unknown> {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate)
  ) {
    throw new TypeError("Expected an object.");
  }
  return candidate as Record<string, unknown>;
}

function exactKeys(
  candidate: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(candidate).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

function deeplyFrozen(candidate: unknown): boolean {
  if (typeof candidate !== "object" || candidate === null) return true;
  if (!Object.isFrozen(candidate)) return false;
  return Object.values(candidate).every(deeplyFrozen);
}

function dispatchResultSnapshot(
  candidate: unknown,
): StartupGatedAttemptDispatchResult {
  try {
    if (!deeplyFrozen(candidate)) {
      throw new TypeError("Dispatch result is mutable.");
    }
    const value = record(immutableEvidenceSnapshot(candidate));
    if (value["state"] !== "settled") {
      return nonSessionAdmissionSnapshot(
        value as Parameters<typeof nonSessionAdmissionSnapshot>[0],
      );
    }
    if (
      !exactKeys(value, ["deliveryId", "execution", "path", "result", "state"])
    ) {
      throw new TypeError("Settled dispatch result is invalid.");
    }
    const execution = terminalExecutionSnapshot(value["execution"]);
    const deliveryId = runnerTaskDeliveryV1Schema.shape.deliveryId.parse(
      value["deliveryId"],
    );
    if (value["path"] === "fresh") {
      const result = freshSessionResultSnapshot(value["result"], execution);
      if (
        result.state === "completed" &&
        result.publication.work.deliveryId !== deliveryId
      ) {
        throw new TypeError("Settled dispatch delivery is inconsistent.");
      }
      return immutableEvidenceSnapshot({
        state: "settled" as const,
        path: "fresh" as const,
        deliveryId,
        execution,
        result,
      });
    }
    if (value["path"] === "restart_recovery") {
      const result = restartSessionResultSnapshot(value["result"], execution);
      if (result.publication.work.deliveryId !== deliveryId) {
        throw new TypeError("Settled dispatch delivery is inconsistent.");
      }
      return immutableEvidenceSnapshot({
        state: "settled" as const,
        path: "restart_recovery" as const,
        deliveryId,
        execution,
        result,
      });
    }
    throw new TypeError("Settled dispatch path is invalid.");
  } catch (cause) {
    throw new LocalAttemptDispatchLoopError("invalid_result", { cause });
  }
}

const stoppedResult: LocalAttemptDispatchLoopResult = Object.freeze({
  state: "stopped",
});

export class LocalAttemptDispatchLoop {
  readonly #dependencies: CapturedDependencies;
  readonly #pollIntervalMs: number;
  #operation: Promise<LocalAttemptDispatchLoopResult> | undefined;

  constructor(options: {
    owner: LocalAttemptDispatchOwner;
    delay: LocalAttemptDispatchDelay;
    observer: LocalAttemptDispatchObserver;
    pollIntervalMs: number;
  }) {
    if (
      !Number.isInteger(options.pollIntervalMs) ||
      options.pollIntervalMs < 1 ||
      options.pollIntervalMs > MAXIMUM_NODE_TIMER_DELAY_MS
    ) {
      throw new LocalAttemptDispatchLoopError("invalid_configuration");
    }
    this.#dependencies = capture(options);
    this.#pollIntervalMs = options.pollIntervalMs;
  }

  run(signal: AbortSignal): Promise<LocalAttemptDispatchLoopResult> {
    this.#operation ??= this.#run(signal);
    return this.#operation;
  }

  async #run(signal: AbortSignal): Promise<LocalAttemptDispatchLoopResult> {
    if (!(signal instanceof AbortSignal)) {
      throw new LocalAttemptDispatchLoopError("invalid_configuration");
    }
    while (!signal.aborted) {
      let candidate: StartupGatedAttemptDispatchResult;
      try {
        candidate = await this.#dependencies.dispatch(signal);
      } catch (cause) {
        if (signal.aborted && cause === signal.reason) return stoppedResult;
        throw new LocalAttemptDispatchLoopError("dispatch_failed", { cause });
      }

      const result = dispatchResultSnapshot(candidate);
      try {
        await this.#dependencies.observe(result);
      } catch (cause) {
        throw new LocalAttemptDispatchLoopError("observation_failed", {
          cause,
        });
      }
      if (signal.aborted) return stoppedResult;

      if (result.state === "idle" || result.state === "indeterminate") {
        try {
          await this.#dependencies.wait(this.#pollIntervalMs, signal);
        } catch (cause) {
          if (signal.aborted && cause === signal.reason) return stoppedResult;
          throw new LocalAttemptDispatchLoopError("delay_failed", { cause });
        }
      }
    }
    return stoppedResult;
  }
}
