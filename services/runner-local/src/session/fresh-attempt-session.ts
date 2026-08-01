import { runnerTaskDeliveryV1Schema } from "@socrates/contracts";

import {
  AttemptExecutionObserver,
  AttemptPreparationCoordinator,
  DurableExecutionTimingBarrier,
  ExecutionPlanProjector,
  type ExecutionImageAdmissionPort,
  type ExecutionSourceArtifactResolver,
  type ExecutionSourceMaterializerPort,
  type LocalExecutionPolicy,
  type MonotonicTimeSource,
} from "../execution";
import {
  TerminalOutcomeArbiter,
  type TerminalAuthorityObservation,
  type TerminalOutcomeDecision,
  type TerminalOutcomeNoEvidenceReason,
} from "../lifecycle";
import type { RuntimeRequestMaterializerPort } from "../runtime";
import {
  RuntimeSandboxExecutor,
  type RuntimeSandboxBackend,
  type RuntimeSandboxExecutorOptions,
} from "../runtime";
import type { SandboxCancellationBackend } from "../supervision/sandbox-cancellation-scope";
import { SandboxCancellationScope } from "../supervision/sandbox-cancellation-scope";
import {
  LeaseAuthorityMonitor,
  LeaseAuthorityMonitorError,
  type LeaseAuthorityCheckpointResult,
  type LeaseAuthorityResult,
  type LeaseAuthorityScheduler,
} from "../supervision/lease-authority-monitor";
import {
  LeaseSupervisor,
  type RunnerHeartbeatControlPlane,
} from "../supervision/lease-supervisor";
import type { WorkAdmissionResult } from "../work-journal/coordinator";
import {
  DurableExecutionStartBarrier,
  type ExecutionStartJournal,
} from "../work-journal/execution-start-barrier";
import {
  immutableEvidenceSnapshot,
  terminalExecutionSnapshot,
} from "../work-journal/terminal-evidence-consistency";
import {
  TerminalEvidencePublicationCoordinator,
  type TerminalEvidenceAppender,
  type TerminalPublicationRecoveryPort,
  type TerminalPublicationWorkJournal,
} from "../work-journal/terminal-evidence-publication";
import {
  TerminalPublicationOwner,
  type TerminalPublicationOwnershipResult,
} from "../work-journal/terminal-publication-owner";
import { sameLeaseAuthorityResult } from "./authority-settlement";

export type ReadyWorkAdmission = Extract<
  WorkAdmissionResult,
  Readonly<{ state: "ready" }>
>;

export interface FreshAttemptSandboxBackend
  extends SandboxCancellationBackend, RuntimeSandboxBackend {}

export interface FreshAttemptJournal
  extends ExecutionStartJournal, TerminalPublicationWorkJournal {}

export type FreshAttemptNoEvidenceAuthority = Extract<
  LeaseAuthorityResult,
  Readonly<{ state: "cancelled" | "released" | "stale" }>
>;

export type FreshAttemptSessionResult =
  | TerminalPublicationOwnershipResult
  | Readonly<{
      state: "no_evidence";
      reason: TerminalOutcomeNoEvidenceReason;
      authority: FreshAttemptNoEvidenceAuthority;
    }>;

export class FreshAttemptSessionError extends Error {
  constructor(
    readonly code:
      | "authority_settlement_uncertain"
      | "invalid_handoff"
      | "settlement_inconsistent",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "FreshAttemptSessionError";
    Object.freeze(this);
  }
}

type PublicationDependencies = Readonly<{
  journal: FreshAttemptJournal;
  spool: TerminalEvidenceAppender;
  recovery: TerminalPublicationRecoveryPort;
  maximumRecoveryAttempts: number;
}>;

function record(candidate: unknown): Record<string, unknown> {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate)
  ) {
    throw new TypeError("Ready handoff must be an object.");
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

function handoffSnapshot(candidate: unknown): ReadyWorkAdmission {
  try {
    const value = record(immutableEvidenceSnapshot(candidate));
    if (
      !exactKeys(value, ["deliveryId", "execution", "recovered", "state"]) ||
      value["state"] !== "ready" ||
      typeof value["recovered"] !== "boolean"
    ) {
      throw new TypeError("Ready handoff shape is invalid.");
    }
    return immutableEvidenceSnapshot({
      state: "ready",
      deliveryId: runnerTaskDeliveryV1Schema.shape.deliveryId.parse(
        value["deliveryId"],
      ),
      execution: terminalExecutionSnapshot(value["execution"]),
      recovered: value["recovered"],
    });
  } catch (cause) {
    throw new FreshAttemptSessionError(
      "invalid_handoff",
      "Fresh attempt handoff is invalid.",
      { cause },
    );
  }
}

function uncertaintyBoundary(
  cause: unknown,
): Extract<TerminalAuthorityObservation, { state: "uncertain" }>["boundary"] {
  if (!(cause instanceof LeaseAuthorityMonitorError)) {
    throw new FreshAttemptSessionError(
      "settlement_inconsistent",
      "Fresh attempt authority observation is inconsistent.",
      { cause },
    );
  }
  switch (cause.code) {
    case "authority_uncertain":
      return "heartbeat";
    case "revocation_failed":
      return "revocation";
    case "scheduler_failed":
      return "scheduler";
    case "monitor_abandoned":
    case "monitor_released":
    case "monitor_stopped":
      throw new FreshAttemptSessionError(
        "settlement_inconsistent",
        "Fresh attempt authority observation is inconsistent.",
        { cause },
      );
  }
}

function authorityObservation(
  result: LeaseAuthorityCheckpointResult,
): TerminalAuthorityObservation {
  return immutableEvidenceSnapshot(result);
}

function noEvidenceAuthority(
  checkpoint: TerminalAuthorityObservation,
  result: LeaseAuthorityResult,
): result is FreshAttemptNoEvidenceAuthority {
  if (checkpoint.state === "renewed") return result.state === "released";
  if (checkpoint.state === "stale") return result.state === "stale";
  if (checkpoint.state === "uncertain") return false;
  return sameLeaseAuthorityResult(checkpoint, result);
}

function maximumRecoveryAttempts(candidate: number): number {
  if (!Number.isSafeInteger(candidate) || candidate < 0 || candidate > 100) {
    throw new RangeError(
      "maximumRecoveryAttempts must be a safe integer between 0 and 100.",
    );
  }
  return candidate;
}

export class FreshAttemptSession {
  readonly #admission: ReadyWorkAdmission;
  readonly #authority: LeaseAuthorityMonitor;
  readonly #arbiter: TerminalOutcomeArbiter;
  readonly #observer: AttemptExecutionObserver;
  readonly #publication: PublicationDependencies;
  #operation: Promise<FreshAttemptSessionResult> | undefined;

  constructor(options: {
    admission: ReadyWorkAdmission;
    controlPlane: RunnerHeartbeatControlPlane;
    scheduler: LeaseAuthorityScheduler;
    sandbox: FreshAttemptSandboxBackend;
    journal: FreshAttemptJournal;
    artifacts: ExecutionSourceArtifactResolver;
    images: ExecutionImageAdmissionPort;
    sources: ExecutionSourceMaterializerPort;
    requests: RuntimeRequestMaterializerPort;
    spool: TerminalEvidenceAppender;
    recovery: TerminalPublicationRecoveryPort;
    executionPolicy: LocalExecutionPolicy;
    time: MonotonicTimeSource;
    runtime: RuntimeSandboxExecutorOptions;
    leaseDurationMs: number;
    heartbeatIntervalMs: number;
    revocationGracePeriodMs: number;
    maximumRecoveryAttempts: number;
  }) {
    const admission = handoffSnapshot(options.admission);
    this.#admission = admission;
    const target = new SandboxCancellationScope(
      admission.execution,
      options.sandbox,
    );
    const supervisor = new LeaseSupervisor({
      client: options.controlPlane,
      target,
      leaseDurationMs: options.leaseDurationMs,
    });
    this.#authority = new LeaseAuthorityMonitor({
      execution: admission.execution,
      supervisor,
      scheduler: options.scheduler,
      target,
      heartbeatIntervalMs: options.heartbeatIntervalMs,
      revocationGracePeriodMs: options.revocationGracePeriodMs,
    });

    const timing = new DurableExecutionTimingBarrier({
      barrier: new DurableExecutionStartBarrier({
        journal: options.journal,
        deliveryId: admission.deliveryId,
        execution: admission.execution,
      }),
      time: options.time,
    });
    const preparation = new AttemptPreparationCoordinator({
      execution: admission.execution,
      projector: new ExecutionPlanProjector(options.executionPolicy),
      artifacts: options.artifacts,
      images: options.images,
      sources: options.sources,
    });
    const runtime = new RuntimeSandboxExecutor(
      options.sandbox,
      options.requests,
      options.runtime,
    );
    this.#observer = new AttemptExecutionObserver({
      execution: admission.execution,
      preparation,
      runtime,
      timing,
      signal: target.signal,
    });
    this.#arbiter = new TerminalOutcomeArbiter(admission.execution);
    this.#publication = Object.freeze({
      journal: options.journal,
      spool: options.spool,
      recovery: options.recovery,
      maximumRecoveryAttempts: maximumRecoveryAttempts(
        options.maximumRecoveryAttempts,
      ),
    });
  }

  settle(): Promise<FreshAttemptSessionResult> {
    this.#operation ??= this.#settle();
    return this.#operation;
  }

  async #settle(): Promise<FreshAttemptSessionResult> {
    const monitorOperation = this.#authority.start();
    void monitorOperation.catch(() => undefined);
    let local: Awaited<ReturnType<AttemptExecutionObserver["observe"]>>;
    try {
      local = await this.#observer.observe();
    } catch (cause) {
      return this.#closeObservationFailure(monitorOperation, cause);
    }
    let authority: TerminalAuthorityObservation;
    try {
      authority = authorityObservation(await this.#authority.checkpoint());
    } catch (cause) {
      authority = Object.freeze({
        state: "uncertain",
        boundary: uncertaintyBoundary(cause),
      });
    }
    const decision = this.#arbiter.decide({ ...local, authority });
    if (decision.state === "no_evidence") {
      return this.#releaseWithoutEvidence(
        decision,
        authority,
        monitorOperation,
      );
    }
    return this.#publish(decision, monitorOperation);
  }

  async #closeObservationFailure(
    monitorOperation: Promise<LeaseAuthorityResult>,
    observationCause: unknown,
  ): Promise<never> {
    const releaseOperation = this.#authority.releaseWithoutEvidence();
    const [release, monitor] = await Promise.allSettled([
      releaseOperation,
      monitorOperation,
    ]);
    if (release.status === "rejected" || monitor.status === "rejected") {
      const authorityCauses = [
        ...(release.status === "rejected" ? [release.reason] : []),
        ...(monitor.status === "rejected" &&
        (release.status !== "rejected" || monitor.reason !== release.reason)
          ? [monitor.reason]
          : []),
      ];
      throw new FreshAttemptSessionError(
        "authority_settlement_uncertain",
        "Fresh attempt authority settlement is uncertain.",
        {
          cause: new AggregateError([observationCause, ...authorityCauses]),
        },
      );
    }
    if (!sameLeaseAuthorityResult(release.value, monitor.value)) {
      throw new FreshAttemptSessionError(
        "settlement_inconsistent",
        "Fresh attempt settlement is inconsistent.",
        { cause: observationCause },
      );
    }
    throw new FreshAttemptSessionError(
      "settlement_inconsistent",
      "Fresh attempt local observation is inconsistent.",
      { cause: observationCause },
    );
  }

  async #releaseWithoutEvidence(
    decision: Extract<TerminalOutcomeDecision, { state: "no_evidence" }>,
    checkpoint: TerminalAuthorityObservation,
    monitorOperation: Promise<LeaseAuthorityResult>,
  ): Promise<FreshAttemptSessionResult> {
    const releaseOperation = this.#authority.releaseWithoutEvidence();
    const [release, monitor] = await Promise.allSettled([
      releaseOperation,
      monitorOperation,
    ]);
    if (release.status === "rejected" || monitor.status === "rejected") {
      let cause: unknown;
      if (release.status === "rejected" && monitor.status === "rejected") {
        cause =
          release.reason === monitor.reason
            ? release.reason
            : new AggregateError([release.reason, monitor.reason]);
      } else if (release.status === "rejected") {
        cause = release.reason;
      } else if (monitor.status === "rejected") {
        cause = monitor.reason;
      }
      throw new FreshAttemptSessionError(
        "authority_settlement_uncertain",
        "Fresh attempt authority settlement is uncertain.",
        { cause },
      );
    }
    if (
      !sameLeaseAuthorityResult(release.value, monitor.value) ||
      !noEvidenceAuthority(checkpoint, monitor.value)
    ) {
      throw new FreshAttemptSessionError(
        "settlement_inconsistent",
        "Fresh attempt settlement is inconsistent.",
      );
    }
    return immutableEvidenceSnapshot({
      state: "no_evidence",
      reason: decision.reason,
      authority: monitor.value,
    });
  }

  async #publish(
    decision: Extract<TerminalOutcomeDecision, { state: "evidence" }>,
    monitorOperation: Promise<LeaseAuthorityResult>,
  ): Promise<TerminalPublicationOwnershipResult> {
    const publication = new TerminalEvidencePublicationCoordinator(
      this.#publication.journal,
      this.#publication.spool,
      this.#publication.recovery,
    );
    const owner = new TerminalPublicationOwner({
      authority: this.#authority,
      maximumRecoveryAttempts: this.#publication.maximumRecoveryAttempts,
      publish: () =>
        publication.publish({
          deliveryId: this.#admission.deliveryId,
          execution: this.#admission.execution,
          drafts: decision.drafts,
        }),
    });
    const ownershipOperation = owner.complete();
    const [ownership, monitor] = await Promise.allSettled([
      ownershipOperation,
      monitorOperation,
    ]);
    if (ownership.status === "rejected") throw ownership.reason;
    if (
      monitor.status === "rejected" ||
      !sameLeaseAuthorityResult(ownership.value.authority, monitor.value)
    ) {
      throw new FreshAttemptSessionError(
        "settlement_inconsistent",
        "Fresh attempt settlement is inconsistent.",
        {
          cause:
            monitor.status === "rejected"
              ? monitor.reason
              : new TypeError("Authority settlement contradicted ownership."),
        },
      );
    }
    return immutableEvidenceSnapshot(ownership.value);
  }
}
