import {
  runnerExecutionV1Schema,
  type RunnerCancellationV1,
  type RunnerExecutionV1,
} from "@socrates/contracts";

import type { LeaseSupervisionResult } from "./lease-supervisor";
import type { SandboxLocalRevocation } from "./sandbox-cancellation-scope";

export interface LeaseAuthoritySupervisor {
  readonly leaseDurationMs: number;
  supervise(execution: RunnerExecutionV1): Promise<LeaseSupervisionResult>;
}

export interface LeaseAuthorityScheduler {
  wait(delayMs: number, signal: AbortSignal): Promise<void>;
}

export interface LeaseAuthorityRevocationTarget {
  revoke(revocation: SandboxLocalRevocation): Promise<void>;
}

export type LeaseAuthorityResult =
  | Readonly<{
      state: "cancelled";
      cancellation: RunnerCancellationV1;
    }>
  | Readonly<{ state: "stale" }>
  | Readonly<{ state: "stopped" }>;

export class LeaseAuthorityMonitorError extends Error {
  constructor(
    readonly code:
      "authority_uncertain" | "revocation_failed" | "scheduler_failed",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LeaseAuthorityMonitorError";
  }
}

function positiveSafeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export class LeaseAuthorityMonitor {
  readonly #execution: RunnerExecutionV1;
  readonly #supervisor: LeaseAuthoritySupervisor;
  readonly #scheduler: LeaseAuthorityScheduler;
  readonly #target: LeaseAuthorityRevocationTarget;
  readonly #heartbeatIntervalMs: number;
  readonly #revocationGracePeriodMs: number;
  #operation: Promise<LeaseAuthorityResult> | undefined;
  #stopRequested = false;
  #scheduledWait: AbortController | undefined;

  constructor(options: {
    execution: RunnerExecutionV1;
    supervisor: LeaseAuthoritySupervisor;
    scheduler: LeaseAuthorityScheduler;
    target: LeaseAuthorityRevocationTarget;
    heartbeatIntervalMs: number;
    revocationGracePeriodMs: number;
  }) {
    this.#execution = deepFreeze(
      runnerExecutionV1Schema.parse(options.execution),
    );
    this.#supervisor = options.supervisor;
    this.#scheduler = options.scheduler;
    this.#target = options.target;
    const leaseDurationMs = positiveSafeInteger(
      "leaseDurationMs",
      options.supervisor.leaseDurationMs,
    );
    this.#heartbeatIntervalMs = positiveSafeInteger(
      "heartbeatIntervalMs",
      options.heartbeatIntervalMs,
    );
    if (this.#heartbeatIntervalMs > Math.floor(leaseDurationMs / 3)) {
      throw new RangeError(
        "heartbeatIntervalMs must not exceed one third of leaseDurationMs.",
      );
    }
    if (
      !Number.isSafeInteger(options.revocationGracePeriodMs) ||
      options.revocationGracePeriodMs < 0 ||
      options.revocationGracePeriodMs > 60_000
    ) {
      throw new RangeError(
        "revocationGracePeriodMs must be between 0 and 60000.",
      );
    }
    this.#revocationGracePeriodMs = options.revocationGracePeriodMs;
  }

  start(): Promise<LeaseAuthorityResult> {
    this.#operation ??= this.#run();
    return this.#operation;
  }

  stop(): Promise<LeaseAuthorityResult> {
    this.#stopRequested = true;
    this.#scheduledWait?.abort();
    return this.start();
  }

  async #run(): Promise<LeaseAuthorityResult> {
    while (!this.#stopRequested) {
      let result: LeaseSupervisionResult;
      try {
        result = await this.#supervisor.supervise(this.#execution);
      } catch (cause) {
        await this.#revoke("lease_uncertain", cause);
        throw new LeaseAuthorityMonitorError(
          "authority_uncertain",
          "Lease authority became uncertain.",
          { cause },
        );
      }

      if (result.state === "cancelled") {
        return Object.freeze({
          state: "cancelled",
          cancellation: deepFreeze({ ...result.cancellation }),
        });
      }
      if (result.state === "stale") {
        await this.#revoke("lease_stale");
        return Object.freeze({ state: "stale" });
      }
      if (this.#stopRequested) break;

      const wait = new AbortController();
      this.#scheduledWait = wait;
      try {
        await this.#scheduler.wait(this.#heartbeatIntervalMs, wait.signal);
      } catch (cause) {
        if (!this.#stopRequested) {
          await this.#revoke("scheduler_failure", cause);
          throw new LeaseAuthorityMonitorError(
            "scheduler_failed",
            "Lease heartbeat scheduling failed.",
            { cause },
          );
        }
      } finally {
        if (this.#scheduledWait === wait) this.#scheduledWait = undefined;
      }
    }
    return Object.freeze({ state: "stopped" });
  }

  async #revoke(
    reason: SandboxLocalRevocation["reason"],
    primaryCause?: unknown,
  ): Promise<void> {
    try {
      await this.#target.revoke({
        reason,
        gracePeriodMs: this.#revocationGracePeriodMs,
      });
    } catch (revocationCause) {
      throw new LeaseAuthorityMonitorError(
        "revocation_failed",
        "Lease authority was lost and local revocation failed.",
        {
          cause:
            primaryCause === undefined
              ? revocationCause
              : new AggregateError([primaryCause, revocationCause]),
        },
      );
    }
  }
}
