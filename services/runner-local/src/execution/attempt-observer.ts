import {
  runnerExecutionV1Schema,
  type RunnerExecutionV1,
} from "@socrates/contracts";

import {
  RuntimeLifecycleAdapterError,
  runtimeLifecycleDrafts,
} from "../lifecycle/adapter";
import {
  localFailureEvidence,
  type LocalFailureCode,
} from "../lifecycle/failure-policy";
import type {
  TerminalExecutionTiming,
  TerminalOutcomeCandidate,
} from "../lifecycle/outcome-arbiter";
import { SandboxBackendError } from "../oci/backend";
import { sandboxAttemptKey } from "../oci/identity";
import { RuntimeSandboxError, type RuntimeSandboxExecutor } from "../runtime";
import {
  AttemptPreparationError,
  type AttemptPreparationCoordinator,
  type PreparedExecutionAttempt,
} from "./preparation-coordinator";
import { ExecutionPlanProjectionError } from "./projector";
import {
  DurableExecutionTimingBarrier,
  DurableExecutionTimingBarrierError,
} from "./timing-barrier";

export type AttemptExecutionObservation = Readonly<{
  timing: TerminalExecutionTiming;
  candidate: TerminalOutcomeCandidate;
}>;

export class AttemptExecutionObservationError extends Error {
  constructor(
    readonly code: "timing_uncertain",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AttemptExecutionObservationError";
  }
}

export type AttemptExecutionPreparationPort = Pick<
  AttemptPreparationCoordinator,
  "prepare" | "release"
>;
export type AttemptExecutionRuntimePort = Pick<
  RuntimeSandboxExecutor,
  "execute"
>;

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function none(): TerminalOutcomeCandidate {
  return Object.freeze({ state: "none" });
}

function failure(code: LocalFailureCode): TerminalOutcomeCandidate {
  const decision = localFailureEvidence({
    kind: "failure",
    code,
    executionStarted: false,
  });
  if (decision.state !== "evidence") {
    throw new TypeError("Local failure policy omitted terminal evidence.");
  }
  return deepFreeze({ state: "failure", draft: decision.draft });
}

function timingUncertain(cause: unknown): never {
  throw new AttemptExecutionObservationError(
    "timing_uncertain",
    "Local execution timing is uncertain.",
    { cause },
  );
}

function timingBoundary(
  candidate: unknown,
): DurableExecutionTimingBarrierError | undefined {
  const pending: unknown[] = [candidate];
  const seen = new Set<unknown>();
  while (pending.length > 0 && seen.size < 32) {
    const cause = pending.shift();
    if (seen.has(cause)) continue;
    seen.add(cause);
    if (cause instanceof DurableExecutionTimingBarrierError) return cause;
    if (cause instanceof AggregateError) {
      for (const nested of cause.errors) {
        if (pending.length + seen.size >= 32) break;
        pending.push(nested);
      }
    }
    if (cause instanceof Error && cause.cause !== undefined) {
      pending.push(cause.cause);
    }
  }
  return undefined;
}

function preparationFailure(
  error: AttemptPreparationError,
): TerminalOutcomeCandidate {
  switch (error.code) {
    case "cancelled":
      return none();
    case "cleanup_failed":
    case "release_failed":
      return failure("cleanup_failed");
    case "invalid_artifact":
    case "invalid_source":
      return failure("source_invalid");
    case "invalid_image":
      return failure("image_rejected");
    case "source_materialization_failed":
      return failure("source_materialization_failed");
    case "source_unavailable":
      return failure("source_unavailable");
    case "invalid_prepared_attempt":
      return failure("unexpected_runner_failure");
  }
}

function runtimeFailure(error: RuntimeSandboxError): TerminalOutcomeCandidate {
  switch (error.code) {
    case "cancelled":
      return none();
    case "request_materialization_failed":
      return failure("request_materialization_failed");
    case "request_release_failed":
    case "cleanup_failed":
      return failure("cleanup_failed");
    case "sandbox_backend_failed":
      return failure("sandbox_backend_failed");
    case "protocol":
    case "runtime_mismatch":
      return failure("runtime_protocol_invalid");
    case "invalid_request":
      return failure("unexpected_runner_failure");
  }
}

function candidateFor(cause: unknown, signal?: AbortSignal) {
  const boundary = timingBoundary(cause);
  if (boundary) {
    if (boundary.code === "timing_uncertain") timingUncertain(boundary);
    return none();
  }
  if (cause instanceof AttemptPreparationError) {
    return preparationFailure(cause);
  }
  if (cause instanceof RuntimeSandboxError) return runtimeFailure(cause);
  if (cause instanceof ExecutionPlanProjectionError) {
    return failure("projection_rejected");
  }
  if (cause instanceof RuntimeLifecycleAdapterError) {
    return failure("runtime_protocol_invalid");
  }
  if (cause instanceof SandboxBackendError) {
    if (cause.code === "aborted") return none();
    if (cause.code === "cleanup") return failure("cleanup_failed");
    return failure("sandbox_backend_failed");
  }
  if (signal?.aborted && cause === signal.reason) return none();
  return failure("unexpected_runner_failure");
}

export class AttemptExecutionObserver {
  readonly #execution: RunnerExecutionV1;
  readonly #preparation: AttemptExecutionPreparationPort;
  readonly #runtime: AttemptExecutionRuntimePort;
  readonly #timing: DurableExecutionTimingBarrier;
  readonly #signal: AbortSignal | undefined;
  #operation: Promise<AttemptExecutionObservation> | undefined;

  constructor(options: {
    execution: RunnerExecutionV1;
    preparation: AttemptExecutionPreparationPort;
    runtime: AttemptExecutionRuntimePort;
    timing: DurableExecutionTimingBarrier;
    signal?: AbortSignal;
  }) {
    this.#execution = deepFreeze(
      runnerExecutionV1Schema.parse(options.execution),
    );
    this.#preparation = options.preparation;
    this.#runtime = options.runtime;
    this.#timing = options.timing;
    this.#signal = options.signal;
  }

  observe(): Promise<AttemptExecutionObservation> {
    this.#operation ??= this.#observe();
    return this.#operation;
  }

  async #observe(): Promise<AttemptExecutionObservation> {
    let prepared: PreparedExecutionAttempt | undefined;
    let candidate: TerminalOutcomeCandidate = none();
    let observationFailure: unknown;
    try {
      prepared = await this.#preparation.prepare(this.#signal);
      this.#assertPrepared(prepared);
      const result = await this.#runtime.execute({
        request: prepared.plan.request,
        image: prepared.image,
        profile: prepared.plan.profile,
        source: prepared.source,
        startBarrier: this.#timing,
        signal: this.#signal,
      });
      candidate = deepFreeze({
        state: "runtime",
        drafts: runtimeLifecycleDrafts({
          execution: this.#execution,
          sourceDigest: prepared.source.digest,
          imageDigest: prepared.image.digest,
          result,
        }),
      });
    } catch (cause) {
      try {
        candidate = candidateFor(cause, this.#signal);
      } catch (normalizationFailure) {
        observationFailure = normalizationFailure;
      }
    }

    if (prepared) {
      try {
        await this.#preparation.release(prepared);
      } catch {
        if (!observationFailure) candidate = failure("cleanup_failed");
      }
    }
    if (observationFailure) throw observationFailure;

    let timing: TerminalExecutionTiming;
    try {
      timing = this.#timing.snapshot();
    } catch (cause) {
      timingUncertain(cause);
    }
    return deepFreeze({ timing, candidate });
  }

  #assertPrepared(prepared: PreparedExecutionAttempt): void {
    const identity = prepared.identity;
    const requestIdentity = prepared.plan.request.identity;
    const lease = this.#execution.lease;
    if (
      identity.runnerId !== lease.runnerId ||
      identity.taskId !== lease.taskId ||
      identity.attemptId !== lease.attemptId ||
      identity.fence !== lease.fence ||
      requestIdentity.runnerId !== lease.runnerId ||
      requestIdentity.taskId !== lease.taskId ||
      requestIdentity.attemptId !== lease.attemptId ||
      requestIdentity.fence !== lease.fence ||
      prepared.source.attemptKey !== sandboxAttemptKey(identity) ||
      prepared.source.digest !== this.#execution.task.source.digest ||
      prepared.plan.request.source.digest !==
        this.#execution.task.source.digest ||
      prepared.image.digest !== this.#execution.task.environment.imageDigest ||
      prepared.image.architecture !==
        this.#execution.task.environment.architecture
    ) {
      throw new AttemptPreparationError(
        "invalid_prepared_attempt",
        "Prepared attempt does not match the frozen execution.",
      );
    }
  }
}
