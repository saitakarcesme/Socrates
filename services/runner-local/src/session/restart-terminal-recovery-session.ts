import { runnerTaskDeliveryV1Schema } from "@socrates/contracts";
import { z } from "zod";

import type { SandboxCancellationBackend } from "../supervision/sandbox-cancellation-scope";
import { SandboxCancellationScope } from "../supervision/sandbox-cancellation-scope";
import {
  LeaseAuthorityMonitor,
  type LeaseAuthorityScheduler,
} from "../supervision/lease-authority-monitor";
import {
  LeaseSupervisor,
  type RunnerHeartbeatControlPlane,
} from "../supervision/lease-supervisor";
import type { WorkAdmissionResult } from "../work-journal/coordinator";
import {
  RecoveryOnlyTerminalPublication,
  type RecoveryOnlyTerminalDispositionPort,
  type RecoveryOnlyTerminalRecoveryPort,
} from "../work-journal/recovery-only-terminal-publication";
import {
  immutableEvidenceSnapshot,
  terminalActiveWorkSnapshot,
  terminalExecutionSnapshot,
} from "../work-journal/terminal-evidence-consistency";
import {
  TerminalPublicationOwner,
  type TerminalPublicationOwnershipResult,
} from "../work-journal/terminal-publication-owner";
import { sameLeaseAuthorityResult } from "./authority-settlement";

export type RecoveryPendingWorkAdmission = Extract<
  WorkAdmissionResult,
  Readonly<{ state: "recovery_pending" }>
>;

export class RestartTerminalRecoverySessionError extends Error {
  constructor(
    readonly code: "invalid_handoff" | "settlement_inconsistent",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RestartTerminalRecoverySessionError";
    Object.freeze(this);
  }
}

function record(candidate: unknown): Record<string, unknown> {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate)
  ) {
    throw new TypeError("Recovery handoff must be an object.");
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

function instant(candidate: unknown): string {
  return z.iso.datetime().parse(candidate);
}

function handoffSnapshot(candidate: unknown): RecoveryPendingWorkAdmission {
  try {
    const value = record(immutableEvidenceSnapshot(candidate));
    if (
      !exactKeys(value, [
        "deliveryId",
        "execution",
        "leaseExpiresAt",
        "observedAt",
        "recovered",
        "state",
        "work",
      ]) ||
      value["state"] !== "recovery_pending" ||
      value["recovered"] !== true
    ) {
      throw new TypeError("Recovery handoff shape is invalid.");
    }
    const deliveryId = runnerTaskDeliveryV1Schema.shape.deliveryId.parse(
      value["deliveryId"],
    );
    const execution = terminalExecutionSnapshot(value["execution"]);
    const work = terminalActiveWorkSnapshot(value["work"], execution);
    if (work.deliveryId !== deliveryId) {
      throw new TypeError("Recovery handoff delivery identity is invalid.");
    }
    return immutableEvidenceSnapshot({
      state: "recovery_pending",
      deliveryId,
      execution,
      work,
      recovered: true,
      observedAt: instant(value["observedAt"]),
      leaseExpiresAt: instant(value["leaseExpiresAt"]),
    });
  } catch (cause) {
    throw new RestartTerminalRecoverySessionError(
      "invalid_handoff",
      "Restart terminal recovery handoff is invalid.",
      { cause },
    );
  }
}

export class RestartTerminalRecoverySession {
  readonly #authority: LeaseAuthorityMonitor;
  readonly #owner: TerminalPublicationOwner;
  #operation: Promise<TerminalPublicationOwnershipResult> | undefined;

  constructor(options: {
    admission: RecoveryPendingWorkAdmission;
    controlPlane: RunnerHeartbeatControlPlane;
    sandbox: SandboxCancellationBackend;
    scheduler: LeaseAuthorityScheduler;
    auditor: RecoveryOnlyTerminalDispositionPort;
    recovery: RecoveryOnlyTerminalRecoveryPort;
    leaseDurationMs: number;
    heartbeatIntervalMs: number;
    revocationGracePeriodMs: number;
    maximumRecoveryAttempts: number;
  }) {
    const admission = handoffSnapshot(options.admission);
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
    const publication = new RecoveryOnlyTerminalPublication({
      work: admission.work,
      deliveryId: admission.deliveryId,
      execution: admission.execution,
      auditor: options.auditor,
      recovery: options.recovery,
    });
    this.#owner = new TerminalPublicationOwner({
      authority: this.#authority,
      maximumRecoveryAttempts: options.maximumRecoveryAttempts,
      publish: () => publication.publish(),
    });
  }

  settle(): Promise<TerminalPublicationOwnershipResult> {
    this.#operation ??= this.#settle();
    return this.#operation;
  }

  async #settle(): Promise<TerminalPublicationOwnershipResult> {
    const authorityOperation = this.#authority.start();
    void authorityOperation.catch(() => undefined);
    const ownershipOperation = this.#owner.complete();
    const [ownership, authority] = await Promise.allSettled([
      ownershipOperation,
      authorityOperation,
    ]);

    if (ownership.status === "rejected") throw ownership.reason;
    if (
      authority.status === "rejected" ||
      !sameLeaseAuthorityResult(ownership.value.authority, authority.value)
    ) {
      throw new RestartTerminalRecoverySessionError(
        "settlement_inconsistent",
        "Restart terminal recovery settlement is inconsistent.",
        {
          cause:
            authority.status === "rejected"
              ? authority.reason
              : new TypeError("Authority settlement contradicted ownership."),
        },
      );
    }
    return immutableEvidenceSnapshot(ownership.value);
  }
}
