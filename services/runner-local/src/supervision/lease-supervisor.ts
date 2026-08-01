import {
  runnerCancellationV1Schema,
  runnerExecutionV1Schema,
  runnerTaskHeartbeatRequestV1Schema,
  type RunnerCancellationV1,
  type RunnerExecutionV1,
  type RunnerTaskHeartbeatRequestV1,
  type RunnerTaskHeartbeatResponseV1,
} from "@socrates/contracts";

import { RunnerTransportError } from "../transport/client";
import type { SandboxTerminationReceipt } from "../oci/termination";

export interface RunnerCancellationTarget {
  cancel(command: RunnerCancellationV1): Promise<SandboxTerminationReceipt>;
}

export interface RunnerHeartbeatControlPlane {
  heartbeat(
    input: {
      taskId: string;
      attemptId: string;
      request: RunnerTaskHeartbeatRequestV1;
    },
    signal?: AbortSignal,
  ): Promise<RunnerTaskHeartbeatResponseV1>;
}

export type LeaseSupervisionResult =
  | Readonly<{ state: "renewed"; leaseExpiresAt: string }>
  | Readonly<{
      state: "cancelled";
      leaseExpiresAt: string;
      cancellation: RunnerCancellationV1;
      termination: SandboxTerminationReceipt;
    }>
  | Readonly<{ state: "stale" }>;

export class LeaseSupervisor {
  readonly #client: RunnerHeartbeatControlPlane;
  readonly #target: RunnerCancellationTarget;
  readonly leaseDurationMs: number;
  #operationTail: Promise<void> | undefined;

  constructor(options: {
    client: RunnerHeartbeatControlPlane;
    target: RunnerCancellationTarget;
    leaseDurationMs: number;
  }) {
    this.#client = options.client;
    this.#target = options.target;
    this.leaseDurationMs = runnerTaskHeartbeatRequestV1Schema.parse({
      version: "1",
      fence: 1,
      leaseDurationMs: options.leaseDurationMs,
    }).leaseDurationMs;
  }

  async supervise(
    candidate: RunnerExecutionV1,
    signal?: AbortSignal,
  ): Promise<LeaseSupervisionResult> {
    return this.#serialize(async () => {
      const execution = runnerExecutionV1Schema.parse(candidate);
      const { lease } = execution;
      let heartbeat;
      try {
        heartbeat = await this.#client.heartbeat(
          {
            taskId: lease.taskId,
            attemptId: lease.attemptId,
            request: {
              version: "1",
              fence: lease.fence,
              leaseDurationMs: this.leaseDurationMs,
            },
          },
          signal,
        );
      } catch (error) {
        if (
          error instanceof RunnerTransportError &&
          error.code === "conflict" &&
          error.response?.status === 409
        ) {
          return Object.freeze({ state: "stale" });
        }
        throw error;
      }

      if (heartbeat.directive === "continue") {
        return Object.freeze({
          state: "renewed",
          leaseExpiresAt: heartbeat.leaseExpiresAt,
        });
      }

      const cancellation = runnerCancellationV1Schema.parse({
        version: "1",
        runnerId: lease.runnerId,
        taskId: lease.taskId,
        attemptId: lease.attemptId,
        fence: lease.fence,
        ...heartbeat.cancellation,
      });
      const termination = await this.#target.cancel(cancellation);
      return Object.freeze({
        state: "cancelled",
        leaseExpiresAt: heartbeat.leaseExpiresAt,
        cancellation,
        termination,
      });
    });
  }

  async #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#operationTail;
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#operationTail = previous ? previous.then(() => current) : current;
    if (previous) await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
