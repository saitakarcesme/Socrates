import {
  clearTimeout as clearNodeTimeout,
  setTimeout as setNodeTimeout,
} from "node:timers";

import type { LeaseAuthorityScheduler } from "./lease-authority-monitor";

const MAXIMUM_NODE_TIMER_DELAY_MS = 2_147_483_647;

export interface NodeTimerDriver {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

type NodeAttemptTimingErrorCode =
  "invalid_driver" | "invalid_wait" | "schedule_failed";

const errorMessages = Object.freeze({
  invalid_driver: "Node timer driver is invalid.",
  invalid_wait: "Node timer wait is invalid.",
  schedule_failed: "Node timer scheduling failed.",
} satisfies Record<NodeAttemptTimingErrorCode, string>);

export class NodeAttemptTimingError extends Error {
  constructor(
    readonly code: NodeAttemptTimingErrorCode,
    options?: ErrorOptions,
  ) {
    super(errorMessages[code], options);
    this.name = "NodeAttemptTimingError";
    Object.freeze(this);
  }
}

const systemNodeTimerDriver: NodeTimerDriver = Object.freeze({
  schedule(callback: () => void, delayMs: number): unknown {
    return setNodeTimeout(callback, delayMs);
  },
  cancel(handle: unknown): void {
    clearNodeTimeout(handle as ReturnType<typeof setNodeTimeout>);
  },
});

type CapturedTimerDriver = Readonly<{
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}>;

function captureTimerDriver(driver: NodeTimerDriver): CapturedTimerDriver {
  try {
    if (
      (typeof driver !== "object" && typeof driver !== "function") ||
      driver === null ||
      typeof driver.schedule !== "function" ||
      typeof driver.cancel !== "function"
    ) {
      throw new TypeError("Invalid timer driver.");
    }
    return Object.freeze({
      schedule: driver.schedule.bind(driver),
      cancel: driver.cancel.bind(driver),
    });
  } catch (cause) {
    throw new NodeAttemptTimingError("invalid_driver", { cause });
  }
}

function isValidWait(delayMs: number, signal: AbortSignal): boolean {
  return (
    Number.isInteger(delayMs) &&
    delayMs >= 1 &&
    delayMs <= MAXIMUM_NODE_TIMER_DELAY_MS &&
    signal instanceof AbortSignal
  );
}

export class NodeLeaseAuthorityScheduler implements LeaseAuthorityScheduler {
  readonly #driver: CapturedTimerDriver;

  constructor(driver: NodeTimerDriver = systemNodeTimerDriver) {
    this.#driver = captureTimerDriver(driver);
  }

  wait(delayMs: number, signal: AbortSignal): Promise<void> {
    if (!isValidWait(delayMs, signal)) {
      return Promise.reject(new NodeAttemptTimingError("invalid_wait"));
    }
    if (signal.aborted) return Promise.reject(signal.reason);

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let handle: unknown;
      let handleReady = false;

      const cancelHandle = (): void => {
        if (!handleReady) return;
        handleReady = false;
        try {
          this.#driver.cancel(handle);
        } catch {
          // Cancellation is best effort. Abort identity remains authoritative.
        }
      };
      const cleanup = (): void => {
        signal.removeEventListener("abort", onAbort);
      };
      const onExpiry = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        cancelHandle();
        reject(signal.reason);
      };

      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }

      try {
        handle = this.#driver.schedule(onExpiry, delayMs);
        handleReady = true;
        if (settled) cancelHandle();
      } catch (cause) {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new NodeAttemptTimingError("schedule_failed", { cause }));
      }
    });
  }
}
