import {
  runnerExecutionV1Schema,
  type RunnerCancellationV1,
  type RunnerExecutionV1,
} from "@socrates/contracts";

import type { LeaseSupervisionResult } from "./lease-supervisor";
import type { SandboxLocalRevocation } from "./sandbox-cancellation-scope";
import type { SandboxTerminationReceipt } from "../oci/termination";

const checkpointWake = Symbol("lease-authority-checkpoint");

export interface LeaseAuthoritySupervisor {
  readonly leaseDurationMs: number;
  supervise(execution: RunnerExecutionV1): Promise<LeaseSupervisionResult>;
}

export interface LeaseAuthorityScheduler {
  wait(delayMs: number, signal: AbortSignal): Promise<void>;
}

export interface LeaseAuthorityRevocationTarget {
  revoke(
    revocation: SandboxLocalRevocation,
  ): Promise<SandboxTerminationReceipt>;
}

export type LeaseAuthorityResult =
  | Readonly<{
      state: "cancelled";
      cancellation: RunnerCancellationV1;
      termination: SandboxTerminationReceipt;
    }>
  | Readonly<{ state: "stale" }>
  | Readonly<{ state: "stopped" }>;

export type LeaseAuthorityCheckpointResult =
  | Readonly<{ state: "renewed"; leaseExpiresAt: string }>
  | Extract<LeaseAuthorityResult, { state: "cancelled" | "stale" }>;

export class LeaseAuthorityMonitorError extends Error {
  constructor(
    readonly code:
      | "authority_uncertain"
      | "monitor_stopped"
      | "revocation_failed"
      | "scheduler_failed",
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

type Checkpoint = Readonly<{
  promise: Promise<LeaseAuthorityCheckpointResult>;
  resolve(result: LeaseAuthorityCheckpointResult): void;
  reject(cause: unknown): void;
}>;

function checkpoint(): Checkpoint {
  let resolve!: (result: LeaseAuthorityCheckpointResult) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<LeaseAuthorityCheckpointResult>(
    (resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    },
  );
  return { promise, resolve, reject };
}

type TerminalMonitorState =
  | Readonly<{ state: "result"; result: LeaseAuthorityResult }>
  | Readonly<{ state: "error"; error: unknown }>;

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
  #checkpoint: Checkpoint | undefined;
  #terminal: TerminalMonitorState | undefined;

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

  checkpoint(): Promise<LeaseAuthorityCheckpointResult> {
    if (this.#terminal) {
      if (this.#terminal.state === "error") {
        return Promise.reject(this.#terminal.error);
      }
      if (this.#terminal.result.state === "stopped") {
        return Promise.reject(this.#stoppedError());
      }
      return Promise.resolve(this.#terminal.result);
    }
    if (this.#stopRequested) return Promise.reject(this.#stoppedError());
    if (this.#checkpoint) return this.#checkpoint.promise;

    const pending = checkpoint();
    this.#checkpoint = pending;
    void this.start().catch(() => undefined);
    this.#scheduledWait?.abort(checkpointWake);
    return pending.promise;
  }

  async #run(): Promise<LeaseAuthorityResult> {
    try {
      const result = await this.#monitor();
      this.#terminal = Object.freeze({ state: "result", result });
      if (result.state !== "stopped") this.#resolveCheckpoint(result);
      return result;
    } catch (cause) {
      this.#terminal = Object.freeze({ state: "error", error: cause });
      this.#rejectCheckpoint(cause);
      throw cause;
    }
  }

  async #monitor(): Promise<LeaseAuthorityResult> {
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
        const cancelled = Object.freeze({
          state: "cancelled",
          cancellation: deepFreeze({ ...result.cancellation }),
          termination: result.termination,
        });
        return cancelled;
      }
      if (result.state === "stale") {
        await this.#revoke("lease_stale");
        const stale = Object.freeze({ state: "stale" as const });
        return stale;
      }
      this.#resolveCheckpoint(
        Object.freeze({
          state: "renewed",
          leaseExpiresAt: result.leaseExpiresAt,
        }),
      );
      if (this.#stopRequested) break;

      const wait = new AbortController();
      this.#scheduledWait = wait;
      try {
        await this.#scheduler.wait(this.#heartbeatIntervalMs, wait.signal);
      } catch (cause) {
        if (
          !this.#stopRequested &&
          !(cause === checkpointWake && this.#checkpoint)
        ) {
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
    this.#rejectCheckpoint(this.#stoppedError());
    return Object.freeze({ state: "stopped" });
  }

  #resolveCheckpoint(result: LeaseAuthorityCheckpointResult): void {
    const pending = this.#checkpoint;
    if (!pending) return;
    this.#checkpoint = undefined;
    pending.resolve(deepFreeze(result));
  }

  #rejectCheckpoint(cause: unknown): void {
    const pending = this.#checkpoint;
    if (!pending) return;
    this.#checkpoint = undefined;
    pending.reject(cause);
  }

  #stoppedError(): LeaseAuthorityMonitorError {
    return new LeaseAuthorityMonitorError(
      "monitor_stopped",
      "Lease authority monitor is stopped.",
    );
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
