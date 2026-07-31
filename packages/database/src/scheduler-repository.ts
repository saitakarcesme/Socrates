import { createHash } from "node:crypto";

import { isVerifiedArtifact } from "@socrates/artifact-store";
import {
  experimentTaskV2Schema,
  runnerAttemptLeaseV1Schema,
  runnerEventV2Schema,
  runnerRegistrationV1Schema,
} from "@socrates/contracts";
import { runnerSatisfiesCapabilities } from "@socrates/domain";
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  max,
  notExists,
  notInArray,
  sql,
} from "drizzle-orm";

import type { RunnerEventV2 } from "@socrates/contracts";
import type { DatabaseTransaction } from "./database-types";
import type { JsonValue } from "./json";
import { maximumRunnerTaskOfferDurationMs } from "./ports";
import type {
  AcquireRunnerTaskDeliveryInput,
  AcquireRunnerTaskDeliveryResult,
  AuthorizeRunnerSourceSnapshotInput,
  AuthorizeRunnerSourceSnapshotResult,
  CatalogSourceSnapshotInput,
  CatalogSourceSnapshotResult,
  ClaimRunnerTaskInput,
  ClaimRunnerTaskDeliveryInput,
  ClaimRunnerTaskDeliveryResult,
  ClaimRunnerTaskResult,
  CompleteRunnerTaskInput,
  CompleteRunnerTaskResult,
  CreateRunnerTaskResult,
  HeartbeatRunnerTaskInput,
  HeartbeatRunnerTaskResult,
  IngestRunnerEventInput,
  IngestRunnerEventResult,
  ReconcileExpiredRunnerTasksInput,
  ReconcileExpiredRunnerTasksResult,
  ReconcileExpiredTaskDeliveriesInput,
  ReconcileExpiredTaskDeliveriesResult,
  RequestRunnerTaskCancellationInput,
  RequestRunnerTaskCancellationResult,
  RunnerRegistrationWrite,
  RunnerTaskTerminalStatus,
  RunnerTaskWrite,
  SchedulerRepository,
} from "./ports";
import { redactRunnerEvent } from "./runner-evidence";
import * as schema from "./schema/index";

const activeAttemptStatuses = [
  "claimed",
  "preparing",
  "executing",
  "measuring",
] as const;
const maximumLeaseDurationMs = 15 * 60 * 1_000;
const maximumReconciliationBatchSize = 100;
const maximumFailureClassificationLength = 120;
const maximumCancellationGracePeriodMs = 60_000;
const cancellationReasons = [
  "operator",
  "budget",
  "policy",
  "runner_shutdown",
] as const;
const terminalTaskStatuses = ["succeeded", "failed", "cancelled"] as const;
const sourceSnapshotMediaType =
  "application/vnd.socrates.source-snapshot.v1+tar";
type PersistedRunnerAttemptStatus =
  (typeof schema.runnerAttemptStatus.enumValues)[number];
type PersistedRunnerTaskStatus =
  (typeof schema.runnerTaskStatus.enumValues)[number];

function assertLeaseDuration(value: number): void {
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > maximumLeaseDurationMs
  ) {
    throw new RangeError(
      `Lease duration must be between 1 and ${maximumLeaseDurationMs} ms.`,
    );
  }
}

function assertCancellationPolicy(
  input: RequestRunnerTaskCancellationInput,
): void {
  if (
    !Number.isSafeInteger(input.gracePeriodMs) ||
    input.gracePeriodMs < 0 ||
    input.gracePeriodMs > maximumCancellationGracePeriodMs
  ) {
    throw new RangeError(
      `Cancellation grace period must be between 0 and ${maximumCancellationGracePeriodMs} ms.`,
    );
  }
  if (!cancellationReasons.includes(input.reason)) {
    throw new RangeError("Cancellation reason is not supported.");
  }
}

function assertOfferDuration(value: number): void {
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > maximumRunnerTaskOfferDurationMs
  ) {
    throw new RangeError(
      `Offer duration must be between 1 and ${maximumRunnerTaskOfferDurationMs} ms.`,
    );
  }
}

function capabilityArray(value: unknown): readonly unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function assertReconciliationLimit(value: number): void {
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > maximumReconciliationBatchSize
  ) {
    throw new RangeError(
      `Reconciliation limit must be between 1 and ${maximumReconciliationBatchSize}.`,
    );
  }
}

function failureClassification(input: CompleteRunnerTaskInput): string | null {
  if (input.outcome.status !== "failed") return null;

  const value = input.outcome.failureClassification.trim();
  if (value.length === 0 || value.length > maximumFailureClassificationLength) {
    throw new RangeError(
      `Failure classification must be between 1 and ${maximumFailureClassificationLength} characters.`,
    );
  }
  return value;
}

function canCompleteTask(
  currentStatus: string,
  terminalStatus: RunnerTaskTerminalStatus,
): boolean {
  if (currentStatus === "cancellation_requested") return true;
  if (currentStatus === "running") {
    return terminalStatus === "succeeded" || terminalStatus === "failed";
  }
  return currentStatus === "leased" && terminalStatus === "failed";
}

function cancellationStatus(
  value: string,
): "cancellation_requested" | "cancelled" {
  if (value === "cancellation_requested" || value === "cancelled") return value;
  throw new Error(`Invalid persisted cancellation status: ${value}.`);
}

function cancellationReason(
  value: string,
): (typeof cancellationReasons)[number] {
  if (cancellationReasons.includes(value as never)) {
    return value as (typeof cancellationReasons)[number];
  }
  throw new Error(`Invalid persisted cancellation reason: ${value}.`);
}

function normalizedEventDigest(event: RunnerEventV2): string {
  return createHash("sha256").update(JSON.stringify(event)).digest("hex");
}

function isActiveAttemptStatus(
  value: string,
): value is (typeof activeAttemptStatuses)[number] {
  return activeAttemptStatuses.some((status) => status === value);
}

function persistedCommandIndex(payload: unknown): number | null {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("commandIndex" in payload) ||
    typeof payload.commandIndex !== "number" ||
    !Number.isSafeInteger(payload.commandIndex)
  ) {
    return null;
  }
  return payload.commandIndex;
}

export class PostgresSchedulerRepository implements SchedulerRepository {
  constructor(private readonly transaction: DatabaseTransaction) {}

  private async appendTaskOutbox(
    taskId: string,
    topic: string,
    payload: JsonValue,
  ): Promise<void> {
    await this.transaction.insert(schema.outboxMessages).values({
      taskId,
      topic,
      payload,
    });
  }

  private async appendProjectedRunnerEvent(
    runId: string,
    event: RunnerEventV2,
  ): Promise<void> {
    const [run] = await this.transaction
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(eq(schema.runs.id, runId))
      .for("update");
    if (!run) throw new Error(`Runner event run ${runId} does not exist.`);

    const [cursor] = await this.transaction
      .select({ value: max(schema.runEvents.sequence) })
      .from(schema.runEvents)
      .where(eq(schema.runEvents.runId, runId));

    await this.transaction.insert(schema.runEvents).values({
      runId,
      sequence: (cursor?.value ?? 0) + 1,
      type: `runner.${event.type}`,
      schemaVersion: "2",
      payload: {
        eventId: event.eventId,
        taskId: event.taskId,
        attemptId: event.attemptId,
        fence: event.fence,
        sequence: event.sequence,
        payload: event.payload,
      },
      occurredAt: new Date(event.occurredAt),
    });
  }

  async registerRunner(input: RunnerRegistrationWrite): Promise<void> {
    const registration = runnerRegistrationV1Schema.parse({
      version: "1",
      runnerId: input.id,
      kind: input.kind,
      softwareVersion: input.softwareVersion,
      taskProtocolVersions: input.taskProtocolVersions,
      eventProtocolVersions: input.eventProtocolVersions,
      sandboxBackend: input.sandboxBackend,
      capabilities: input.capabilities,
      capacity: {
        maximumConcurrentTasks: input.maximumConcurrentTasks,
      },
    });

    await this.transaction.insert(schema.runnerRegistrations).values({
      id: registration.runnerId,
      workspaceId: input.workspaceId,
      kind: registration.kind,
      softwareVersion: registration.softwareVersion,
      taskProtocolVersions: [...registration.taskProtocolVersions],
      eventProtocolVersions: [...registration.eventProtocolVersions],
      sandboxBackend: registration.sandboxBackend,
      capabilities: registration.capabilities,
      maximumConcurrentTasks: registration.capacity.maximumConcurrentTasks,
    });
  }

  async createTask(input: RunnerTaskWrite): Promise<CreateRunnerTaskResult> {
    const task = experimentTaskV2Schema.parse(input.payload);
    if (
      task.taskId !== input.id ||
      task.runId !== input.runId ||
      task.experimentId !== input.experimentId ||
      task.version !== input.protocolVersion
    ) {
      throw new TypeError(
        "Runner task payload identity does not match its scheduling projection.",
      );
    }

    const [queuedExperiment] = await this.transaction
      .update(schema.experiments)
      .set({
        status: "queued",
        version: sql`${schema.experiments.version} + 1`,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(
        and(
          eq(schema.experiments.id, input.experimentId),
          eq(schema.experiments.runId, input.runId),
          eq(schema.experiments.status, "proposed"),
          eq(schema.experiments.version, input.expectedExperimentVersion),
        ),
      )
      .returning({ id: schema.experiments.id });

    if (!queuedExperiment) {
      return { state: "experiment_unavailable" };
    }

    const { expectedExperimentVersion: _, ...taskProjection } = input;
    void _;
    await this.transaction.insert(schema.runnerTasks).values({
      ...taskProjection,
      payload: task,
      requiredCapabilities: task.environment.requiredCapabilities,
      retrySafe: task.action.retrySafe,
    });
    await this.appendTaskOutbox(input.id, "runner.task.queued", {
      version: "1",
      taskId: input.id,
      workspaceId: input.workspaceId,
    });
    return { state: "created" };
  }

  async acquireTaskDelivery(
    input: AcquireRunnerTaskDeliveryInput,
  ): Promise<AcquireRunnerTaskDeliveryResult> {
    assertOfferDuration(input.offerDurationMs);
    const [runner] = await this.transaction
      .select({
        id: schema.runnerRegistrations.id,
        workspaceId: schema.runnerRegistrations.workspaceId,
        status: schema.runnerRegistrations.status,
        capabilities: schema.runnerRegistrations.capabilities,
        maximumConcurrentTasks:
          schema.runnerRegistrations.maximumConcurrentTasks,
      })
      .from(schema.runnerRegistrations)
      .where(eq(schema.runnerRegistrations.id, input.runnerId))
      .for("update");
    if (!runner) return { state: "runner_not_found" };
    if (runner.status !== "active") return { state: "runner_unavailable" };

    const [existing] = await this.transaction
      .select({
        deliveryId: schema.runnerTaskDeliveries.id,
        taskId: schema.runnerTaskDeliveries.taskId,
      })
      .from(schema.runnerTaskDeliveries)
      .where(
        and(
          eq(schema.runnerTaskDeliveries.runnerId, runner.id),
          eq(schema.runnerTaskDeliveries.state, "offered"),
          sql`${schema.runnerTaskDeliveries.expiresAt} > CURRENT_TIMESTAMP`,
        ),
      )
      .orderBy(
        asc(schema.runnerTaskDeliveries.offeredAt),
        asc(schema.runnerTaskDeliveries.id),
      )
      .limit(1)
      .for("update");
    if (existing) return { state: "acquired", delivery: existing };

    const [usage] = await this.transaction
      .select({ value: count() })
      .from(schema.runnerTaskAttempts)
      .where(
        and(
          eq(schema.runnerTaskAttempts.runnerId, runner.id),
          inArray(schema.runnerTaskAttempts.status, activeAttemptStatuses),
          sql`${schema.runnerTaskAttempts.leaseExpiresAt} > CURRENT_TIMESTAMP`,
        ),
      );
    if ((usage?.value ?? 0) >= runner.maximumConcurrentTasks) {
      return { state: "runner_at_capacity" };
    }

    const available = capabilityArray(runner.capabilities);
    if (!available) return { state: "none" };
    const candidates = await this.transaction
      .select({
        id: schema.runnerTasks.id,
        requiredCapabilities: schema.runnerTasks.requiredCapabilities,
      })
      .from(schema.runnerTasks)
      .where(
        and(
          eq(schema.runnerTasks.workspaceId, runner.workspaceId),
          eq(schema.runnerTasks.status, "queued"),
          eq(schema.runnerTasks.protocolVersion, "2"),
          notExists(
            this.transaction
              .select({ id: schema.runnerTaskDeliveries.id })
              .from(schema.runnerTaskDeliveries)
              .where(
                and(
                  eq(schema.runnerTaskDeliveries.taskId, schema.runnerTasks.id),
                  inArray(schema.runnerTaskDeliveries.state, [
                    "offered",
                    "claimed",
                  ]),
                ),
              ),
          ),
        ),
      )
      .orderBy(asc(schema.runnerTasks.createdAt), asc(schema.runnerTasks.id))
      .limit(32)
      .for("update", { of: schema.runnerTasks, skipLocked: true });

    const candidate = candidates.find((task) => {
      const required = capabilityArray(task.requiredCapabilities);
      return required && runnerSatisfiesCapabilities(available, required);
    });
    if (!candidate) return { state: "none" };

    const [delivery] = await this.transaction
      .insert(schema.runnerTaskDeliveries)
      .values({
        workspaceId: runner.workspaceId,
        taskId: candidate.id,
        runnerId: runner.id,
        expiresAt: sql`CURRENT_TIMESTAMP + (${input.offerDurationMs} * INTERVAL '1 millisecond')`,
      })
      .returning({
        deliveryId: schema.runnerTaskDeliveries.id,
        taskId: schema.runnerTaskDeliveries.taskId,
      });
    if (!delivery) throw new Error("Task delivery insert returned no record.");
    return { state: "acquired", delivery };
  }

  async claimTaskDelivery(
    input: ClaimRunnerTaskDeliveryInput,
  ): Promise<ClaimRunnerTaskDeliveryResult> {
    const [runner] = await this.transaction
      .select({ id: schema.runnerRegistrations.id })
      .from(schema.runnerRegistrations)
      .where(eq(schema.runnerRegistrations.id, input.runnerId))
      .for("update");
    if (!runner) return { state: "delivery_not_found" };

    const [delivery] = await this.transaction
      .select({
        id: schema.runnerTaskDeliveries.id,
        runnerId: schema.runnerTaskDeliveries.runnerId,
        taskId: schema.runnerTaskDeliveries.taskId,
        state: schema.runnerTaskDeliveries.state,
        attemptId: schema.runnerTaskDeliveries.attemptId,
        fence: schema.runnerTaskDeliveries.fence,
        unexpired: sql<boolean>`${schema.runnerTaskDeliveries.expiresAt} > CURRENT_TIMESTAMP`,
      })
      .from(schema.runnerTaskDeliveries)
      .where(eq(schema.runnerTaskDeliveries.id, input.deliveryId))
      .for("update");
    if (!delivery || delivery.runnerId !== input.runnerId) {
      return { state: "delivery_not_found" };
    }
    if (delivery.taskId !== input.taskId) {
      return { state: "delivery_conflict" };
    }
    if (
      delivery.state === "revoked" ||
      (delivery.state === "offered" && !delivery.unexpired)
    ) {
      return { state: "delivery_conflict" };
    }
    if (
      delivery.state === "claimed" &&
      (delivery.attemptId !== input.attemptId || delivery.fence === null)
    ) {
      return { state: "delivery_conflict" };
    }

    const result = await this.claimTask(input);
    if (result.state !== "claimed") return result;
    if (delivery.state === "claimed") {
      return result.claim.fence === delivery.fence
        ? result
        : { state: "delivery_conflict" };
    }

    const [claimed] = await this.transaction
      .update(schema.runnerTaskDeliveries)
      .set({
        state: "claimed",
        attemptId: result.claim.attemptId,
        fence: result.claim.fence,
        claimedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(
        and(
          eq(schema.runnerTaskDeliveries.id, delivery.id),
          eq(schema.runnerTaskDeliveries.state, "offered"),
        ),
      )
      .returning({ id: schema.runnerTaskDeliveries.id });
    if (!claimed) return { state: "delivery_conflict" };
    return result;
  }

  async reconcileExpiredTaskDeliveries(
    input: ReconcileExpiredTaskDeliveriesInput,
  ): Promise<ReconcileExpiredTaskDeliveriesResult> {
    assertReconciliationLimit(input.limit);
    const expired = await this.transaction
      .select({
        deliveryId: schema.runnerTaskDeliveries.id,
        taskId: schema.runnerTaskDeliveries.taskId,
        runnerId: schema.runnerTaskDeliveries.runnerId,
      })
      .from(schema.runnerTaskDeliveries)
      .where(
        and(
          eq(schema.runnerTaskDeliveries.state, "offered"),
          sql`${schema.runnerTaskDeliveries.expiresAt} <= CURRENT_TIMESTAMP`,
        ),
      )
      .orderBy(
        asc(schema.runnerTaskDeliveries.expiresAt),
        asc(schema.runnerTaskDeliveries.id),
      )
      .limit(input.limit)
      .for("update", { skipLocked: true });

    const revoked: ReconcileExpiredTaskDeliveriesResult["revoked"][number][] =
      [];
    for (const delivery of expired) {
      const [updated] = await this.transaction
        .update(schema.runnerTaskDeliveries)
        .set({
          state: "revoked",
          revokedAt: sql`CURRENT_TIMESTAMP`,
          revocationReason: "expired",
        })
        .where(
          and(
            eq(schema.runnerTaskDeliveries.id, delivery.deliveryId),
            eq(schema.runnerTaskDeliveries.state, "offered"),
            sql`${schema.runnerTaskDeliveries.expiresAt} <= CURRENT_TIMESTAMP`,
          ),
        )
        .returning({ id: schema.runnerTaskDeliveries.id });
      if (updated) revoked.push({ ...delivery, reason: "expired" });
    }
    return { revoked: Object.freeze(revoked) };
  }

  async claimTask(input: ClaimRunnerTaskInput): Promise<ClaimRunnerTaskResult> {
    assertLeaseDuration(input.leaseDurationMs);

    const [runner] = await this.transaction
      .select({
        id: schema.runnerRegistrations.id,
        workspaceId: schema.runnerRegistrations.workspaceId,
        status: schema.runnerRegistrations.status,
        capabilities: schema.runnerRegistrations.capabilities,
        maximumConcurrentTasks:
          schema.runnerRegistrations.maximumConcurrentTasks,
      })
      .from(schema.runnerRegistrations)
      .where(eq(schema.runnerRegistrations.id, input.runnerId))
      .for("update");

    if (!runner) return { state: "runner_not_found" };
    if (runner.status !== "active") return { state: "runner_unavailable" };

    const [existingAttempt] = await this.transaction
      .select({
        id: schema.runnerTaskAttempts.id,
        taskId: schema.runnerTaskAttempts.taskId,
        runnerId: schema.runnerTaskAttempts.runnerId,
        fence: schema.runnerTaskAttempts.fence,
        leaseExpiresAt: schema.runnerTaskAttempts.leaseExpiresAt,
        leaseActive: sql<boolean>`${schema.runnerTaskAttempts.leaseExpiresAt} > CURRENT_TIMESTAMP`,
        taskStatus: schema.runnerTasks.status,
        currentFence: schema.runnerTasks.currentFence,
        payload: schema.runnerTasks.payload,
      })
      .from(schema.runnerTaskAttempts)
      .innerJoin(
        schema.runnerTasks,
        eq(schema.runnerTasks.id, schema.runnerTaskAttempts.taskId),
      )
      .where(eq(schema.runnerTaskAttempts.id, input.attemptId))
      .for("update");

    if (existingAttempt) {
      if (
        existingAttempt.runnerId !== input.runnerId ||
        existingAttempt.taskId !== input.taskId
      ) {
        return { state: "attempt_conflict" };
      }
      if (
        existingAttempt.leaseActive &&
        existingAttempt.currentFence === existingAttempt.fence &&
        ["leased", "running", "cancellation_requested"].includes(
          existingAttempt.taskStatus,
        )
      ) {
        return {
          state: "claimed",
          claim: {
            runnerId: existingAttempt.runnerId,
            taskId: existingAttempt.taskId,
            attemptId: existingAttempt.id,
            fence: existingAttempt.fence,
            leaseExpiresAt: existingAttempt.leaseExpiresAt,
            payload: existingAttempt.payload as JsonValue,
          },
        };
      }
      return { state: "task_unavailable" };
    }

    const [usage] = await this.transaction
      .select({ value: count() })
      .from(schema.runnerTaskAttempts)
      .where(
        and(
          eq(schema.runnerTaskAttempts.runnerId, input.runnerId),
          inArray(schema.runnerTaskAttempts.status, activeAttemptStatuses),
          sql`${schema.runnerTaskAttempts.leaseExpiresAt} > CURRENT_TIMESTAMP`,
        ),
      );
    if ((usage?.value ?? 0) >= runner.maximumConcurrentTasks) {
      return { state: "runner_at_capacity" };
    }

    const [task] = await this.transaction
      .select({
        id: schema.runnerTasks.id,
        workspaceId: schema.runnerTasks.workspaceId,
        status: schema.runnerTasks.status,
        protocolVersion: schema.runnerTasks.protocolVersion,
        payload: schema.runnerTasks.payload,
        requiredCapabilities: schema.runnerTasks.requiredCapabilities,
        currentFence: schema.runnerTasks.currentFence,
      })
      .from(schema.runnerTasks)
      .where(eq(schema.runnerTasks.id, input.taskId))
      .for("update");

    if (!task || task.workspaceId !== runner.workspaceId) {
      return { state: "task_not_found" };
    }
    if (task.status !== "queued" || task.protocolVersion !== "2") {
      return { state: "task_unavailable" };
    }

    const available = capabilityArray(runner.capabilities);
    const required = capabilityArray(task.requiredCapabilities);
    if (
      !available ||
      !required ||
      !runnerSatisfiesCapabilities(available, required)
    ) {
      return { state: "capability_mismatch" };
    }

    const fence = task.currentFence + 1;
    if (!Number.isSafeInteger(fence) || fence > 2_147_483_647) {
      throw new RangeError("Runner task fence is exhausted.");
    }

    const [claimedTask] = await this.transaction
      .update(schema.runnerTasks)
      .set({
        status: "leased",
        currentFence: fence,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(
        and(
          eq(schema.runnerTasks.id, task.id),
          eq(schema.runnerTasks.status, "queued"),
          eq(schema.runnerTasks.currentFence, task.currentFence),
        ),
      )
      .returning({ id: schema.runnerTasks.id });

    if (!claimedTask) return { state: "task_unavailable" };

    const [attempt] = await this.transaction
      .insert(schema.runnerTaskAttempts)
      .values({
        id: input.attemptId,
        taskId: task.id,
        runnerId: runner.id,
        fence,
        leaseExpiresAt: sql`CURRENT_TIMESTAMP + (${input.leaseDurationMs} * INTERVAL '1 millisecond')`,
        lastHeartbeatAt: sql`CURRENT_TIMESTAMP`,
      })
      .returning({
        id: schema.runnerTaskAttempts.id,
        leaseExpiresAt: schema.runnerTaskAttempts.leaseExpiresAt,
      });

    if (!attempt) {
      throw new Error("Runner task attempt insert returned no record.");
    }

    return {
      state: "claimed",
      claim: {
        runnerId: runner.id,
        taskId: task.id,
        attemptId: attempt.id,
        fence,
        leaseExpiresAt: attempt.leaseExpiresAt,
        payload: task.payload as JsonValue,
      },
    };
  }

  async heartbeat(
    input: HeartbeatRunnerTaskInput,
  ): Promise<HeartbeatRunnerTaskResult> {
    assertLeaseDuration(input.leaseDurationMs);

    const [renewed] = await this.transaction
      .update(schema.runnerTaskAttempts)
      .set({
        lastHeartbeatAt: sql`CURRENT_TIMESTAMP`,
        leaseExpiresAt: sql`CURRENT_TIMESTAMP + (${input.leaseDurationMs} * INTERVAL '1 millisecond')`,
      })
      .where(
        and(
          eq(schema.runnerTaskAttempts.id, input.attemptId),
          eq(schema.runnerTaskAttempts.taskId, input.taskId),
          eq(schema.runnerTaskAttempts.runnerId, input.runnerId),
          eq(schema.runnerTaskAttempts.fence, input.fence),
          inArray(schema.runnerTaskAttempts.status, activeAttemptStatuses),
          sql`${schema.runnerTaskAttempts.leaseExpiresAt} > CURRENT_TIMESTAMP`,
          sql`EXISTS (
            SELECT 1 FROM ${schema.runnerTasks}
            WHERE ${schema.runnerTasks.id} = ${input.taskId}
              AND ${schema.runnerTasks.currentFence} = ${input.fence}
              AND ${schema.runnerTasks.status} IN ('leased', 'running', 'cancellation_requested')
          )`,
        ),
      )
      .returning({
        leaseExpiresAt: schema.runnerTaskAttempts.leaseExpiresAt,
      });

    if (!renewed) return { state: "stale" };

    await this.transaction
      .update(schema.runnerRegistrations)
      .set({
        lastHeartbeatAt: sql`CURRENT_TIMESTAMP`,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(schema.runnerRegistrations.id, input.runnerId));

    const [task] = await this.transaction
      .select({
        status: schema.runnerTasks.status,
        requestedAt: schema.runnerTaskCancellations.requestedAt,
        gracePeriodMs: schema.runnerTaskCancellations.gracePeriodMs,
        reason: schema.runnerTaskCancellations.reason,
      })
      .from(schema.runnerTasks)
      .leftJoin(
        schema.runnerTaskCancellations,
        eq(schema.runnerTaskCancellations.taskId, schema.runnerTasks.id),
      )
      .where(eq(schema.runnerTasks.id, input.taskId));
    if (!task) {
      throw new Error(
        "Renewed runner task disappeared inside the transaction.",
      );
    }

    if (task.status !== "cancellation_requested") {
      return {
        state: "renewed",
        leaseExpiresAt: renewed.leaseExpiresAt,
        directive: "continue",
      };
    }
    if (
      task.requestedAt === null ||
      task.gracePeriodMs === null ||
      task.reason === null ||
      !cancellationReasons.includes(task.reason as never)
    ) {
      throw new Error("Cancellation-requested task has no durable policy.");
    }
    return {
      state: "renewed",
      leaseExpiresAt: renewed.leaseExpiresAt,
      directive: "cancel",
      cancellation: {
        requestedAt: task.requestedAt,
        gracePeriodMs: task.gracePeriodMs,
        reason: cancellationReason(task.reason),
      },
    };
  }

  async requestCancellation(
    input: RequestRunnerTaskCancellationInput,
  ): Promise<RequestRunnerTaskCancellationResult> {
    assertCancellationPolicy(input);
    await this.transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.requestId}, 0))`,
    );

    const [task] = await this.transaction
      .select({
        id: schema.runnerTasks.id,
        workspaceId: schema.runnerTasks.workspaceId,
        status: schema.runnerTasks.status,
      })
      .from(schema.runnerTasks)
      .where(eq(schema.runnerTasks.id, input.taskId))
      .for("update");

    if (!task || task.workspaceId !== input.workspaceId) {
      return { state: "task_not_found" };
    }

    const [existingCancellation] = await this.transaction
      .select({
        requestId: schema.runnerTaskCancellations.id,
        taskId: schema.runnerTaskCancellations.taskId,
        taskStatus: schema.runnerTaskCancellations.resultingTaskStatus,
        requestedAt: schema.runnerTaskCancellations.requestedAt,
        gracePeriodMs: schema.runnerTaskCancellations.gracePeriodMs,
        reason: schema.runnerTaskCancellations.reason,
      })
      .from(schema.runnerTaskCancellations)
      .where(eq(schema.runnerTaskCancellations.taskId, task.id))
      .for("update");

    if (existingCancellation) {
      return {
        state: "accepted",
        cancellation: {
          ...existingCancellation,
          taskStatus: cancellationStatus(existingCancellation.taskStatus),
          reason: cancellationReason(existingCancellation.reason),
        },
      };
    }
    if (
      terminalTaskStatuses.includes(task.status as RunnerTaskTerminalStatus)
    ) {
      return { state: "task_not_cancellable" };
    }

    const [requestCollision] = await this.transaction
      .select({ taskId: schema.runnerTaskCancellations.taskId })
      .from(schema.runnerTaskCancellations)
      .where(eq(schema.runnerTaskCancellations.id, input.requestId));
    if (requestCollision) return { state: "request_conflict" };

    const taskStatus =
      task.status === "queued" ? "cancelled" : "cancellation_requested";
    const [updatedTask] = await this.transaction
      .update(schema.runnerTasks)
      .set({
        status: taskStatus,
        cancellationRequestedAt: sql`CURRENT_TIMESTAMP`,
        terminalAt: taskStatus === "cancelled" ? sql`CURRENT_TIMESTAMP` : null,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(
        and(
          eq(schema.runnerTasks.id, task.id),
          eq(schema.runnerTasks.status, task.status),
        ),
      )
      .returning({ id: schema.runnerTasks.id });
    if (!updatedTask) return { state: "task_not_cancellable" };

    const [cancellation] = await this.transaction
      .insert(schema.runnerTaskCancellations)
      .values({
        id: input.requestId,
        taskId: task.id,
        resultingTaskStatus: taskStatus,
        gracePeriodMs: input.gracePeriodMs,
        reason: input.reason,
      })
      .returning({
        requestId: schema.runnerTaskCancellations.id,
        taskId: schema.runnerTaskCancellations.taskId,
        taskStatus: schema.runnerTaskCancellations.resultingTaskStatus,
        requestedAt: schema.runnerTaskCancellations.requestedAt,
        gracePeriodMs: schema.runnerTaskCancellations.gracePeriodMs,
        reason: schema.runnerTaskCancellations.reason,
      });
    if (!cancellation) {
      throw new Error("Runner task cancellation insert returned no record.");
    }

    await this.appendTaskOutbox(
      task.id,
      taskStatus === "cancelled"
        ? "runner.task.cancelled"
        : "runner.task.cancellation_requested",
      {
        version: "1",
        taskId: task.id,
        requestId: input.requestId,
        gracePeriodMs: input.gracePeriodMs,
        reason: input.reason,
      },
    );

    return {
      state: "accepted",
      cancellation: {
        ...cancellation,
        taskStatus: cancellationStatus(cancellation.taskStatus),
        reason: cancellationReason(cancellation.reason),
      },
    };
  }

  async completeTask(
    input: CompleteRunnerTaskInput,
  ): Promise<CompleteRunnerTaskResult> {
    const classification = failureClassification(input);
    const [current] = await this.transaction
      .select({
        taskStatus: schema.runnerTasks.status,
        currentFence: schema.runnerTasks.currentFence,
        attemptStatus: schema.runnerTaskAttempts.status,
        runnerId: schema.runnerTaskAttempts.runnerId,
        fence: schema.runnerTaskAttempts.fence,
        leaseActive: sql<boolean>`${schema.runnerTaskAttempts.leaseExpiresAt} > CURRENT_TIMESTAMP`,
      })
      .from(schema.runnerTasks)
      .innerJoin(
        schema.runnerTaskAttempts,
        and(
          eq(schema.runnerTaskAttempts.taskId, schema.runnerTasks.id),
          eq(schema.runnerTaskAttempts.id, input.attemptId),
        ),
      )
      .where(eq(schema.runnerTasks.id, input.taskId))
      .for("update", {
        of: [schema.runnerTasks, schema.runnerTaskAttempts],
      });

    if (
      !current ||
      current.runnerId !== input.runnerId ||
      current.fence !== input.fence ||
      current.currentFence !== input.fence ||
      !current.leaseActive ||
      !activeAttemptStatuses.includes(
        current.attemptStatus as (typeof activeAttemptStatuses)[number],
      )
    ) {
      return { state: "stale" };
    }
    if (!canCompleteTask(current.taskStatus, input.outcome.status)) {
      return { state: "invalid_transition" };
    }

    const [completedTask] = await this.transaction
      .update(schema.runnerTasks)
      .set({
        status: input.outcome.status,
        terminalAt: sql`CURRENT_TIMESTAMP`,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(
        and(
          eq(schema.runnerTasks.id, input.taskId),
          eq(schema.runnerTasks.currentFence, input.fence),
          eq(schema.runnerTasks.status, current.taskStatus),
        ),
      )
      .returning({ terminalAt: schema.runnerTasks.terminalAt });
    if (!completedTask?.terminalAt) return { state: "stale" };

    const [completedAttempt] = await this.transaction
      .update(schema.runnerTaskAttempts)
      .set({
        status: input.outcome.status,
        completedAt: completedTask.terminalAt,
        failureClassification: classification,
      })
      .where(
        and(
          eq(schema.runnerTaskAttempts.id, input.attemptId),
          eq(schema.runnerTaskAttempts.taskId, input.taskId),
          eq(schema.runnerTaskAttempts.runnerId, input.runnerId),
          eq(schema.runnerTaskAttempts.fence, input.fence),
          inArray(schema.runnerTaskAttempts.status, activeAttemptStatuses),
        ),
      )
      .returning({ id: schema.runnerTaskAttempts.id });
    if (!completedAttempt) {
      throw new Error("Locked runner attempt could not be completed.");
    }

    await this.appendTaskOutbox(
      input.taskId,
      `runner.task.${input.outcome.status}`,
      {
        version: "1",
        taskId: input.taskId,
        attemptId: input.attemptId,
        fence: input.fence,
        status: input.outcome.status,
      },
    );

    return {
      state: "completed",
      taskStatus: input.outcome.status,
      completedAt: completedTask.terminalAt,
    };
  }

  async reconcileExpiredTasks(
    input: ReconcileExpiredRunnerTasksInput,
  ): Promise<ReconcileExpiredRunnerTasksResult> {
    assertReconciliationLimit(input.limit);

    const expiredAttempts = await this.transaction
      .select({
        taskId: schema.runnerTasks.id,
        taskStatus: schema.runnerTasks.status,
        retrySafe: schema.runnerTasks.retrySafe,
        currentFence: schema.runnerTasks.currentFence,
        attemptId: schema.runnerTaskAttempts.id,
        fence: schema.runnerTaskAttempts.fence,
      })
      .from(schema.runnerTaskAttempts)
      .innerJoin(
        schema.runnerTasks,
        and(
          eq(schema.runnerTasks.id, schema.runnerTaskAttempts.taskId),
          eq(schema.runnerTasks.currentFence, schema.runnerTaskAttempts.fence),
        ),
      )
      .where(
        and(
          inArray(schema.runnerTaskAttempts.status, activeAttemptStatuses),
          sql`${schema.runnerTaskAttempts.leaseExpiresAt} <= CURRENT_TIMESTAMP`,
          inArray(schema.runnerTasks.status, [
            "leased",
            "running",
            "cancellation_requested",
          ]),
        ),
      )
      .orderBy(
        asc(schema.runnerTaskAttempts.leaseExpiresAt),
        asc(schema.runnerTaskAttempts.id),
      )
      .limit(input.limit)
      .for("update", {
        of: [schema.runnerTaskAttempts, schema.runnerTasks],
        skipLocked: true,
      });

    const reconciled: ReconcileExpiredRunnerTasksResult["reconciled"][number][] =
      [];
    for (const expired of expiredAttempts) {
      await this.transaction
        .update(schema.runnerTaskAttempts)
        .set({
          status: "expired",
          completedAt: sql`CURRENT_TIMESTAMP`,
        })
        .where(
          and(
            eq(schema.runnerTaskAttempts.id, expired.attemptId),
            eq(schema.runnerTaskAttempts.taskId, expired.taskId),
            eq(schema.runnerTaskAttempts.fence, expired.fence),
            inArray(schema.runnerTaskAttempts.status, activeAttemptStatuses),
          ),
        );

      const outcome =
        expired.taskStatus === "cancellation_requested"
          ? "cancelled"
          : expired.retrySafe
            ? "requeued"
            : "failed";
      const taskStatus = outcome === "requeued" ? "queued" : outcome;
      await this.transaction
        .update(schema.runnerTasks)
        .set({
          status: taskStatus,
          terminalAt: outcome === "requeued" ? null : sql`CURRENT_TIMESTAMP`,
          updatedAt: sql`CURRENT_TIMESTAMP`,
        })
        .where(
          and(
            eq(schema.runnerTasks.id, expired.taskId),
            eq(schema.runnerTasks.currentFence, expired.currentFence),
            eq(schema.runnerTasks.status, expired.taskStatus),
          ),
        );

      await this.appendTaskOutbox(expired.taskId, `runner.task.${outcome}`, {
        version: "1",
        taskId: expired.taskId,
        attemptId: expired.attemptId,
        fence: expired.fence,
        outcome,
      });
      reconciled.push({
        taskId: expired.taskId,
        attemptId: expired.attemptId,
        outcome,
      });
    }

    return { reconciled };
  }

  async catalogSourceSnapshot(
    input: CatalogSourceSnapshotInput,
  ): Promise<CatalogSourceSnapshotResult> {
    const snapshotId =
      experimentTaskV2Schema.shape.source.shape.snapshotId.parse(
        input.snapshotId,
      );
    if (
      !isVerifiedArtifact(input.artifact) ||
      input.artifact.sizeBytes < 1 ||
      input.mediaType !== sourceSnapshotMediaType
    ) {
      throw new TypeError(
        "Source snapshot cataloging requires a genuine non-empty canonical artifact.",
      );
    }

    await this.transaction
      .insert(schema.artifactObjects)
      .values({
        digest: input.artifact.digest,
        sizeBytes: input.artifact.sizeBytes,
      })
      .onConflictDoNothing();
    const [artifact] = await this.transaction
      .select({ sizeBytes: schema.artifactObjects.sizeBytes })
      .from(schema.artifactObjects)
      .where(eq(schema.artifactObjects.digest, input.artifact.digest));
    if (artifact?.sizeBytes !== input.artifact.sizeBytes) {
      return { state: "conflict" };
    }

    const [created] = await this.transaction
      .insert(schema.sourceSnapshots)
      .values({
        id: snapshotId,
        digest: input.artifact.digest,
        sizeBytes: input.artifact.sizeBytes,
        mediaType: input.mediaType,
      })
      .onConflictDoNothing()
      .returning({ id: schema.sourceSnapshots.id });
    if (created) return { state: "created" };

    const [existing] = await this.transaction
      .select({
        digest: schema.sourceSnapshots.digest,
        sizeBytes: schema.sourceSnapshots.sizeBytes,
        mediaType: schema.sourceSnapshots.mediaType,
      })
      .from(schema.sourceSnapshots)
      .where(eq(schema.sourceSnapshots.id, snapshotId));
    return existing?.digest === input.artifact.digest &&
      existing.sizeBytes === input.artifact.sizeBytes &&
      existing.mediaType === input.mediaType
      ? { state: "replay" }
      : { state: "conflict" };
  }

  async authorizeSourceSnapshot(
    input: AuthorizeRunnerSourceSnapshotInput,
  ): Promise<AuthorizeRunnerSourceSnapshotResult> {
    const runnerId = runnerAttemptLeaseV1Schema.shape.runnerId.parse(
      input.runnerId,
    );
    const taskId = runnerAttemptLeaseV1Schema.shape.taskId.parse(input.taskId);
    const attemptId = runnerAttemptLeaseV1Schema.shape.attemptId.parse(
      input.attemptId,
    );
    const fence = runnerAttemptLeaseV1Schema.shape.fence.parse(input.fence);
    const snapshotId =
      experimentTaskV2Schema.shape.source.shape.snapshotId.parse(
        input.snapshotId,
      );
    const digest = experimentTaskV2Schema.shape.source.shape.digest.parse(
      input.digest,
    );

    const [current] = await this.transaction
      .select({
        payload: schema.runnerTasks.payload,
        protocolVersion: schema.runnerTasks.protocolVersion,
      })
      .from(schema.runnerTaskAttempts)
      .innerJoin(
        schema.runnerTasks,
        eq(schema.runnerTasks.id, schema.runnerTaskAttempts.taskId),
      )
      .where(
        and(
          eq(schema.runnerTaskAttempts.id, attemptId),
          eq(schema.runnerTaskAttempts.taskId, taskId),
          eq(schema.runnerTaskAttempts.runnerId, runnerId),
          eq(schema.runnerTaskAttempts.fence, fence),
          inArray(schema.runnerTaskAttempts.status, activeAttemptStatuses),
          sql`${schema.runnerTaskAttempts.leaseExpiresAt} > CURRENT_TIMESTAMP`,
          eq(schema.runnerTasks.id, taskId),
          eq(schema.runnerTasks.currentFence, fence),
          inArray(schema.runnerTasks.status, ["leased", "running"]),
        ),
      );
    if (!current || current.protocolVersion !== "2") return { state: "stale" };

    const task = experimentTaskV2Schema.safeParse(current.payload);
    if (
      !task.success ||
      task.data.source.snapshotId !== snapshotId ||
      task.data.source.digest !== digest
    ) {
      return { state: "source_mismatch" };
    }

    const [source] = await this.transaction
      .select({
        snapshotId: schema.sourceSnapshots.id,
        digest: schema.sourceSnapshots.digest,
        sizeBytes: schema.sourceSnapshots.sizeBytes,
        mediaType: schema.sourceSnapshots.mediaType,
      })
      .from(schema.sourceSnapshots)
      .where(eq(schema.sourceSnapshots.id, snapshotId));
    if (!source) return { state: "source_not_found" };
    if (
      source.digest !== digest ||
      !Number.isSafeInteger(source.sizeBytes) ||
      source.sizeBytes < 1 ||
      source.mediaType !== sourceSnapshotMediaType
    ) {
      return { state: "source_mismatch" };
    }
    return { state: "authorized", source: Object.freeze(source) };
  }

  async ingestEvent(
    input: IngestRunnerEventInput,
  ): Promise<IngestRunnerEventResult> {
    const event = redactRunnerEvent(runnerEventV2Schema.parse(input.event));
    const digest = normalizedEventDigest(event);

    const admissionIdentities = [
      event.eventId,
      ...(event.type === "artifact.produced" ? [event.payload.artifactId] : []),
    ].sort();
    for (const identity of admissionIdentities) {
      await this.transaction.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${identity}, 0))`,
      );
    }

    const [existingEvent] = await this.transaction
      .select({
        eventId: schema.runnerTaskEvents.id,
        attemptId: schema.runnerTaskEvents.attemptId,
        sequence: schema.runnerTaskEvents.sequence,
        digest: schema.runnerTaskEvents.envelopeDigest,
        receivedAt: schema.runnerTaskEvents.receivedAt,
      })
      .from(schema.runnerTaskEvents)
      .where(eq(schema.runnerTaskEvents.id, event.eventId));
    if (existingEvent) {
      if (existingEvent.digest !== digest) {
        return { state: "event_conflict" };
      }
      return {
        state: "replay",
        acknowledgement: {
          eventId: existingEvent.eventId,
          attemptId: existingEvent.attemptId,
          acknowledgedSequence: existingEvent.sequence,
          expectedSequence: existingEvent.sequence + 1,
          receivedAt: existingEvent.receivedAt,
        },
      };
    }

    const [current] = await this.transaction
      .select({
        runId: schema.runnerTasks.runId,
        taskStatus: schema.runnerTasks.status,
        currentFence: schema.runnerTasks.currentFence,
        taskPayload: schema.runnerTasks.payload,
        attemptStatus: schema.runnerTaskAttempts.status,
        runnerId: schema.runnerTaskAttempts.runnerId,
        taskId: schema.runnerTaskAttempts.taskId,
        fence: schema.runnerTaskAttempts.fence,
        lastEventSequence: schema.runnerTaskAttempts.lastEventSequence,
        acceptedLogBytes: schema.runnerTaskAttempts.acceptedLogBytes,
        acceptedArtifactBytes: schema.runnerTaskAttempts.acceptedArtifactBytes,
        leaseActive: sql<boolean>`${schema.runnerTaskAttempts.leaseExpiresAt} > CURRENT_TIMESTAMP`,
      })
      .from(schema.runnerTaskAttempts)
      .innerJoin(
        schema.runnerTasks,
        eq(schema.runnerTasks.id, schema.runnerTaskAttempts.taskId),
      )
      .where(eq(schema.runnerTaskAttempts.id, event.attemptId))
      .for("update", {
        of: [schema.runnerTaskAttempts, schema.runnerTasks],
      });

    if (
      !current ||
      current.runnerId !== event.runnerId ||
      current.taskId !== event.taskId ||
      current.fence !== event.fence ||
      current.currentFence !== event.fence ||
      !current.leaseActive ||
      !isActiveAttemptStatus(current.attemptStatus) ||
      !["leased", "running", "cancellation_requested"].includes(
        current.taskStatus,
      )
    ) {
      return { state: "stale" };
    }

    const expectedSequence = current.lastEventSequence + 1;
    const [occupiedSequence] = await this.transaction
      .select({ id: schema.runnerTaskEvents.id })
      .from(schema.runnerTaskEvents)
      .where(
        and(
          eq(schema.runnerTaskEvents.attemptId, event.attemptId),
          eq(schema.runnerTaskEvents.sequence, event.sequence),
        ),
      );
    if (occupiedSequence) return { state: "event_conflict" };
    if (event.sequence > expectedSequence) {
      return { state: "gap", expectedSequence };
    }
    if (event.sequence < expectedSequence) return { state: "stale" };

    const taskSnapshot = experimentTaskV2Schema.parse(current.taskPayload);
    let acceptedLogByteDelta = 0;
    let acceptedArtifactByteDelta = 0;
    if (event.type === "log.appended") {
      acceptedLogByteDelta = event.payload.utf8Bytes;
      if (
        acceptedLogByteDelta >
        taskSnapshot.budget.logBytes - current.acceptedLogBytes
      ) {
        return {
          state: "budget_exhausted",
          dimension: "log_bytes",
          limitBytes: taskSnapshot.budget.logBytes,
          acceptedBytes: current.acceptedLogBytes,
          attemptedBytes: acceptedLogByteDelta,
        };
      }
    }
    if (event.type === "artifact.produced") {
      if (
        !isVerifiedArtifact(input.verifiedArtifact) ||
        input.verifiedArtifact.digest !== event.payload.digest ||
        input.verifiedArtifact.sizeBytes !== event.payload.sizeBytes
      ) {
        return { state: "invalid_evidence" };
      }
      acceptedArtifactByteDelta = event.payload.sizeBytes;
      if (
        acceptedArtifactByteDelta >
        taskSnapshot.budget.artifactBytes - current.acceptedArtifactBytes
      ) {
        return {
          state: "budget_exhausted",
          dimension: "artifact_bytes",
          limitBytes: taskSnapshot.budget.artifactBytes,
          acceptedBytes: current.acceptedArtifactBytes,
          attemptedBytes: acceptedArtifactByteDelta,
        };
      }
      const [occupiedArtifact] = await this.transaction
        .select({ eventId: schema.runnerTaskArtifacts.eventId })
        .from(schema.runnerTaskArtifacts)
        .where(eq(schema.runnerTaskArtifacts.id, event.payload.artifactId));
      if (occupiedArtifact) return { state: "event_conflict" };
    }

    const [previousEvent] =
      current.lastEventSequence === 0
        ? []
        : await this.transaction
            .select({
              type: schema.runnerTaskEvents.type,
              payload: schema.runnerTaskEvents.payload,
            })
            .from(schema.runnerTaskEvents)
            .where(
              and(
                eq(schema.runnerTaskEvents.attemptId, event.attemptId),
                notInArray(schema.runnerTaskEvents.type, [
                  "log.appended",
                  "artifact.produced",
                ]),
                sql`${schema.runnerTaskEvents.sequence} <= ${current.lastEventSequence}`,
              ),
            )
            .orderBy(desc(schema.runnerTaskEvents.sequence))
            .limit(1);
    let nextAttemptStatus: PersistedRunnerAttemptStatus = current.attemptStatus;
    let nextTaskStatus: PersistedRunnerTaskStatus = current.taskStatus;

    switch (event.type) {
      case "workspace.prepared":
        if (
          previousEvent ||
          event.payload.sourceDigest !== taskSnapshot.source.digest ||
          event.payload.imageDigest !== taskSnapshot.environment.imageDigest
        ) {
          return { state: "invalid_evidence" };
        }
        if (
          current.attemptStatus !== "claimed" ||
          current.taskStatus !== "leased"
        ) {
          return { state: "invalid_transition" };
        }
        nextAttemptStatus = "preparing";
        break;
      case "action.started":
        if (
          event.payload.commandIndex >= taskSnapshot.action.steps.length ||
          (event.payload.commandIndex === 0
            ? previousEvent?.type !== "workspace.prepared"
            : previousEvent?.type !== "action.completed" ||
              persistedCommandIndex(previousEvent.payload) !==
                event.payload.commandIndex - 1)
        ) {
          return { state: "invalid_evidence" };
        }
        if (
          !["preparing", "executing"].includes(current.attemptStatus) ||
          !["leased", "running"].includes(current.taskStatus)
        ) {
          return { state: "invalid_transition" };
        }
        nextAttemptStatus = "executing";
        nextTaskStatus = "running";
        break;
      case "action.completed":
        if (
          event.payload.commandIndex >= taskSnapshot.action.steps.length ||
          previousEvent?.type !== "action.started" ||
          persistedCommandIndex(previousEvent.payload) !==
            event.payload.commandIndex
        ) {
          return { state: "invalid_evidence" };
        }
        if (
          current.attemptStatus !== "executing" ||
          current.taskStatus !== "running"
        ) {
          return { state: "invalid_transition" };
        }
        break;
      case "log.appended":
      case "artifact.produced":
        break;
      case "measurement.recorded":
        if (
          event.payload.metricDefinitionId !==
            taskSnapshot.measurement.metricDefinitionId ||
          event.payload.unit !== taskSnapshot.measurement.unit ||
          previousEvent?.type !== "action.completed" ||
          persistedCommandIndex(previousEvent.payload) !==
            taskSnapshot.action.steps.length - 1
        ) {
          return { state: "invalid_evidence" };
        }
        if (
          current.attemptStatus !== "executing" ||
          current.taskStatus !== "running"
        ) {
          return { state: "invalid_transition" };
        }
        nextAttemptStatus = "measuring";
        break;
      case "task.succeeded":
        if (
          current.attemptStatus !== "measuring" ||
          !["running", "cancellation_requested"].includes(current.taskStatus)
        ) {
          return { state: "invalid_transition" };
        }
        nextAttemptStatus = "succeeded";
        nextTaskStatus = "succeeded";
        break;
      case "task.failed":
        nextAttemptStatus = "failed";
        nextTaskStatus = "failed";
        break;
      case "task.cancelled":
        if (current.taskStatus !== "cancellation_requested") {
          return { state: "invalid_transition" };
        }
        nextAttemptStatus = "cancelled";
        nextTaskStatus = "cancelled";
        break;
    }

    const [storedEvent] = await this.transaction
      .insert(schema.runnerTaskEvents)
      .values({
        id: event.eventId,
        taskId: event.taskId,
        attemptId: event.attemptId,
        runnerId: event.runnerId,
        fence: event.fence,
        sequence: event.sequence,
        protocolVersion: event.version,
        type: event.type,
        payload: event.payload,
        envelopeDigest: digest,
        occurredAt: new Date(event.occurredAt),
      })
      .returning({ receivedAt: schema.runnerTaskEvents.receivedAt });
    if (!storedEvent)
      throw new Error("Runner event insert returned no record.");

    if (event.type === "artifact.produced") {
      await this.transaction
        .insert(schema.artifactObjects)
        .values({
          digest: event.payload.digest,
          sizeBytes: event.payload.sizeBytes,
        })
        .onConflictDoNothing();
      const [artifactObject] = await this.transaction
        .select({ sizeBytes: schema.artifactObjects.sizeBytes })
        .from(schema.artifactObjects)
        .where(eq(schema.artifactObjects.digest, event.payload.digest));
      if (artifactObject?.sizeBytes !== event.payload.sizeBytes) {
        throw new Error(
          "Verified artifact identity conflicts with stored content metadata.",
        );
      }
      await this.transaction.insert(schema.runnerTaskArtifacts).values({
        id: event.payload.artifactId,
        digest: event.payload.digest,
        taskId: event.taskId,
        attemptId: event.attemptId,
        runnerId: event.runnerId,
        fence: event.fence,
        eventId: event.eventId,
        mediaType: event.payload.mediaType,
        role: event.payload.role,
      });
    }

    const terminal = ["succeeded", "failed", "cancelled"].includes(
      nextTaskStatus,
    );
    const [updatedAttempt] = await this.transaction
      .update(schema.runnerTaskAttempts)
      .set({
        status: nextAttemptStatus,
        lastEventSequence: event.sequence,
        acceptedLogBytes:
          acceptedLogByteDelta === 0
            ? undefined
            : sql`${schema.runnerTaskAttempts.acceptedLogBytes} + ${acceptedLogByteDelta}`,
        acceptedArtifactBytes:
          acceptedArtifactByteDelta === 0
            ? undefined
            : sql`${schema.runnerTaskAttempts.acceptedArtifactBytes} + ${acceptedArtifactByteDelta}`,
        startedAt:
          event.type === "action.started"
            ? sql`COALESCE(${schema.runnerTaskAttempts.startedAt}, CURRENT_TIMESTAMP)`
            : undefined,
        completedAt: terminal ? sql`CURRENT_TIMESTAMP` : undefined,
        failureClassification:
          event.type === "task.failed" ? event.payload.classification : null,
      })
      .where(
        and(
          eq(schema.runnerTaskAttempts.id, event.attemptId),
          eq(schema.runnerTaskAttempts.taskId, event.taskId),
          eq(schema.runnerTaskAttempts.runnerId, event.runnerId),
          eq(schema.runnerTaskAttempts.fence, event.fence),
          eq(
            schema.runnerTaskAttempts.lastEventSequence,
            current.lastEventSequence,
          ),
          eq(schema.runnerTaskAttempts.status, current.attemptStatus),
        ),
      )
      .returning({ id: schema.runnerTaskAttempts.id });
    if (!updatedAttempt) {
      throw new Error("Locked runner attempt event cursor could not advance.");
    }

    if (nextTaskStatus !== current.taskStatus) {
      const [updatedTask] = await this.transaction
        .update(schema.runnerTasks)
        .set({
          status: nextTaskStatus,
          terminalAt: terminal ? sql`CURRENT_TIMESTAMP` : undefined,
          updatedAt: sql`CURRENT_TIMESTAMP`,
        })
        .where(
          and(
            eq(schema.runnerTasks.id, event.taskId),
            eq(schema.runnerTasks.currentFence, event.fence),
            eq(schema.runnerTasks.status, current.taskStatus),
          ),
        )
        .returning({ id: schema.runnerTasks.id });
      if (!updatedTask) {
        throw new Error("Locked runner task lifecycle could not advance.");
      }
    }

    if (terminal) {
      await this.appendTaskOutbox(
        event.taskId,
        `runner.task.${nextTaskStatus}`,
        {
          version: "1",
          taskId: event.taskId,
          attemptId: event.attemptId,
          fence: event.fence,
          status: nextTaskStatus,
          eventId: event.eventId,
        },
      );
    }
    if (event.type !== "log.appended") {
      await this.appendProjectedRunnerEvent(current.runId, event);
    }

    return {
      state: "accepted",
      acknowledgement: {
        eventId: event.eventId,
        attemptId: event.attemptId,
        acknowledgedSequence: event.sequence,
        expectedSequence: event.sequence + 1,
        receivedAt: storedEvent.receivedAt,
      },
    };
  }
}
