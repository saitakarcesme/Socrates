import type { VerifiedArtifact } from "@socrates/artifact-store";

import type { CommandRepository } from "./command-model";
import type { JsonValue } from "./json";
import type { ReadRepository } from "./read-model";

export type { JsonPrimitive, JsonValue } from "./json";

export type IdempotencyClaimInput = {
  workspaceId: string;
  key: string;
  commandName: string;
  requestHash: string;
};

export type IdempotencyResponse = {
  status: number;
  body: JsonValue;
};

export type IdempotencyClaim =
  | { state: "claimed" }
  | { state: "in_progress" }
  | { state: "conflict" }
  | { state: "replay"; response: IdempotencyResponse };

export interface IdempotencyRepository {
  claim(input: IdempotencyClaimInput): Promise<IdempotencyClaim>;
  complete(
    input: IdempotencyClaimInput,
    response: IdempotencyResponse,
  ): Promise<void>;
}

export type AppendRunEventInput = {
  runId: string;
  type: string;
  schemaVersion: string;
  payload: JsonValue;
  occurredAt?: Date;
};

export type RunEventRecord = {
  id: string;
  runId: string;
  sequence: number;
  type: string;
  schemaVersion: string;
  payload: JsonValue;
  occurredAt: Date;
};

export interface RunEventRepository {
  append(input: AppendRunEventInput): Promise<RunEventRecord>;
}

export type RunnerRegistrationWrite = {
  id: string;
  workspaceId: string;
  kind: "local" | "cloud" | "distributed";
  softwareVersion: string;
  taskProtocolVersions: readonly string[];
  eventProtocolVersions: readonly string[];
  sandboxBackend: "oci";
  capabilities: JsonValue;
  maximumConcurrentTasks: number;
};

export type RunnerCredentialCandidate = {
  tokenId: string;
  runnerId: string;
  workspaceId: string;
  secretDigest: string;
  usable: boolean;
};

export type ProvisionRunnerCredentialInput = {
  tokenId: string;
  runnerId: string;
  secretDigest: string;
  label: string;
  expiresAt: Date;
};

export type ProvisionRunnerCredentialResult =
  { state: "created" } | { state: "runner_not_found" | "token_conflict" };

export interface RunnerCredentialRepository {
  findCandidate(tokenId: string): Promise<RunnerCredentialCandidate | null>;
  provision(
    input: ProvisionRunnerCredentialInput,
  ): Promise<ProvisionRunnerCredentialResult>;
}

export type RunnerTaskWrite = {
  id: string;
  workspaceId: string;
  projectId: string;
  runId: string;
  experimentId: string;
  expectedExperimentVersion: number;
  protocolVersion: "2";
  payload: JsonValue;
};

export type CreateRunnerTaskResult =
  { state: "created" } | { state: "experiment_unavailable" };

export type ClaimRunnerTaskInput = {
  runnerId: string;
  taskId: string;
  attemptId: string;
  leaseDurationMs: number;
};

export type AcquireRunnerTaskDeliveryInput = {
  runnerId: string;
  offerDurationMs: number;
};

export const maximumRunnerTaskOfferDurationMs = 15 * 60 * 1_000;

export type RunnerTaskDelivery = {
  deliveryId: string;
  taskId: string;
};

export type AcquireRunnerTaskDeliveryResult =
  | { state: "acquired"; delivery: RunnerTaskDelivery }
  | {
      state:
        | "none"
        | "runner_not_found"
        | "runner_unavailable"
        | "runner_at_capacity";
    };

export type ClaimRunnerTaskDeliveryInput = ClaimRunnerTaskInput & {
  deliveryId: string;
};

export type ClaimRunnerTaskDeliveryResult =
  | { state: "claimed"; claim: ClaimedRunnerTask }
  | {
      state:
        | "delivery_not_found"
        | "delivery_conflict"
        | Exclude<ClaimRunnerTaskResult["state"], "claimed">;
    };

export type ReconcileExpiredTaskDeliveriesInput = { limit: number };

export type RevokedRunnerTaskDelivery = {
  deliveryId: string;
  taskId: string;
  runnerId: string;
  reason: "expired";
};

export type ReconcileExpiredTaskDeliveriesResult = {
  revoked: readonly RevokedRunnerTaskDelivery[];
};

export type ClaimedRunnerTask = {
  runnerId: string;
  taskId: string;
  attemptId: string;
  fence: number;
  leaseExpiresAt: Date;
  payload: JsonValue;
};

export type ClaimRunnerTaskResult =
  | { state: "claimed"; claim: ClaimedRunnerTask }
  | {
      state:
        | "runner_not_found"
        | "runner_unavailable"
        | "runner_at_capacity"
        | "attempt_conflict"
        | "task_not_found"
        | "task_unavailable"
        | "capability_mismatch";
    };

export type HeartbeatRunnerTaskInput = {
  runnerId: string;
  taskId: string;
  attemptId: string;
  fence: number;
  leaseDurationMs: number;
};

export type HeartbeatRunnerTaskResult =
  | {
      state: "renewed";
      leaseExpiresAt: Date;
      directive: "continue";
    }
  | {
      state: "renewed";
      leaseExpiresAt: Date;
      directive: "cancel";
      cancellation: {
        requestedAt: Date;
        gracePeriodMs: number;
        reason: "operator" | "budget" | "policy" | "runner_shutdown";
      };
    }
  | { state: "stale" };

export type ReconcileRunnerAttemptInput = {
  runnerId: string;
  taskId: string;
  attemptId: string;
  fence: number;
};

export type RunnerAttemptRetirementReason =
  | "lease_expired_requeued"
  | "lease_expired_failed"
  | "lease_expired_cancelled"
  | "attempt_terminal"
  | "task_terminal"
  | "fence_superseded";

export type ReconcileRunnerAttemptResult =
  | { state: "current"; observedAt: Date; leaseExpiresAt: Date }
  | {
      state: "retired";
      observedAt: Date;
      reason: RunnerAttemptRetirementReason;
    }
  | { state: "identity_conflict" };

export type RequestRunnerTaskCancellationInput = {
  requestId: string;
  workspaceId: string;
  taskId: string;
  gracePeriodMs: number;
  reason: "operator" | "budget" | "policy" | "runner_shutdown";
};

export type RunnerTaskCancellationAcceptance = {
  requestId: string;
  taskId: string;
  taskStatus: "cancellation_requested" | "cancelled";
  requestedAt: Date;
  gracePeriodMs: number;
  reason: "operator" | "budget" | "policy" | "runner_shutdown";
};

export type RequestRunnerTaskCancellationResult =
  | { state: "accepted"; cancellation: RunnerTaskCancellationAcceptance }
  | { state: "request_conflict" | "task_not_found" | "task_not_cancellable" };

export type RunnerTaskTerminalStatus = "succeeded" | "failed" | "cancelled";

export type CompleteRunnerTaskInput = {
  runnerId: string;
  taskId: string;
  attemptId: string;
  fence: number;
  outcome:
    | { status: "succeeded" }
    | { status: "failed"; failureClassification: string }
    | { status: "cancelled" };
};

export type CompleteRunnerTaskResult =
  | {
      state: "completed";
      taskStatus: RunnerTaskTerminalStatus;
      completedAt: Date;
    }
  | { state: "invalid_transition" | "stale" };

export type ReconcileExpiredRunnerTasksInput = {
  limit: number;
};

export type ReconciledRunnerTask = {
  taskId: string;
  attemptId: string;
  outcome: "requeued" | "failed" | "cancelled";
};

export type ReconcileExpiredRunnerTasksResult = {
  reconciled: readonly ReconciledRunnerTask[];
};

export type IngestRunnerEventInput = {
  event: JsonValue;
  verifiedArtifact?: VerifiedArtifact;
};

export type RunnerEventAcknowledgement = {
  eventId: string;
  attemptId: string;
  acknowledgedSequence: number;
  expectedSequence: number;
  receivedAt: Date;
};

export type IngestRunnerEventResult =
  | {
      state: "accepted" | "replay";
      acknowledgement: RunnerEventAcknowledgement;
    }
  | { state: "gap"; expectedSequence: number }
  | {
      state: "budget_exhausted";
      dimension: "log_bytes" | "artifact_bytes";
      limitBytes: number;
      acceptedBytes: number;
      attemptedBytes: number;
    }
  | {
      state:
        | "event_conflict"
        | "invalid_evidence"
        | "invalid_transition"
        | "stale"
        | "unsupported_event";
    };

export type CatalogSourceSnapshotInput = {
  snapshotId: string;
  artifact: VerifiedArtifact;
  mediaType: string;
};

export type CatalogSourceSnapshotResult =
  { state: "created" | "replay" } | { state: "conflict" };

export type AuthorizeRunnerSourceSnapshotInput = {
  runnerId: string;
  taskId: string;
  attemptId: string;
  fence: number;
  snapshotId: string;
  digest: string;
};

export type AuthorizedSourceSnapshot = {
  snapshotId: string;
  digest: string;
  sizeBytes: number;
  mediaType: string;
};

export type AuthorizeRunnerSourceSnapshotResult =
  | { state: "authorized"; source: AuthorizedSourceSnapshot }
  | { state: "source_not_found" | "source_mismatch" | "stale" };

export interface SchedulerRepository {
  registerRunner(input: RunnerRegistrationWrite): Promise<void>;
  createTask(input: RunnerTaskWrite): Promise<CreateRunnerTaskResult>;
  acquireTaskDelivery(
    input: AcquireRunnerTaskDeliveryInput,
  ): Promise<AcquireRunnerTaskDeliveryResult>;
  claimTaskDelivery(
    input: ClaimRunnerTaskDeliveryInput,
  ): Promise<ClaimRunnerTaskDeliveryResult>;
  reconcileExpiredTaskDeliveries(
    input: ReconcileExpiredTaskDeliveriesInput,
  ): Promise<ReconcileExpiredTaskDeliveriesResult>;
  claimTask(input: ClaimRunnerTaskInput): Promise<ClaimRunnerTaskResult>;
  heartbeat(
    input: HeartbeatRunnerTaskInput,
  ): Promise<HeartbeatRunnerTaskResult>;
  reconcileAttempt(
    input: ReconcileRunnerAttemptInput,
  ): Promise<ReconcileRunnerAttemptResult>;
  requestCancellation(
    input: RequestRunnerTaskCancellationInput,
  ): Promise<RequestRunnerTaskCancellationResult>;
  completeTask(
    input: CompleteRunnerTaskInput,
  ): Promise<CompleteRunnerTaskResult>;
  reconcileExpiredTasks(
    input: ReconcileExpiredRunnerTasksInput,
  ): Promise<ReconcileExpiredRunnerTasksResult>;
  ingestEvent(input: IngestRunnerEventInput): Promise<IngestRunnerEventResult>;
  catalogSourceSnapshot(
    input: CatalogSourceSnapshotInput,
  ): Promise<CatalogSourceSnapshotResult>;
  authorizeSourceSnapshot(
    input: AuthorizeRunnerSourceSnapshotInput,
  ): Promise<AuthorizeRunnerSourceSnapshotResult>;
}

export type TransactionRepositories = {
  commands: CommandRepository;
  idempotency: IdempotencyRepository;
  runEvents: RunEventRepository;
  scheduler: SchedulerRepository;
};

export interface Persistence {
  readonly reads: ReadRepository;
  readonly runnerCredentials: RunnerCredentialRepository;
  transaction<T>(
    work: (repositories: TransactionRepositories) => Promise<T>,
  ): Promise<T>;
  close(): Promise<void>;
}
