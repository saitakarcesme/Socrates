import { and, count, eq, inArray, sql } from "drizzle-orm";
import {
  experimentTaskV2Schema,
  runnerRegistrationV1Schema,
} from "@socrates/contracts";
import { runnerSatisfiesCapabilities } from "@socrates/domain";

import type { DatabaseTransaction } from "./database-types";
import type { JsonValue } from "./json";
import type {
  ClaimRunnerTaskInput,
  ClaimRunnerTaskResult,
  CreateRunnerTaskResult,
  HeartbeatRunnerTaskInput,
  HeartbeatRunnerTaskResult,
  RunnerRegistrationWrite,
  RunnerTaskWrite,
  SchedulerRepository,
} from "./ports";
import * as schema from "./schema/index";

const activeAttemptStatuses = [
  "claimed",
  "preparing",
  "executing",
  "measuring",
] as const;
const maximumLeaseDurationMs = 15 * 60 * 1_000;

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

function capabilityArray(value: unknown): readonly unknown[] | null {
  return Array.isArray(value) ? value : null;
}

export class PostgresSchedulerRepository implements SchedulerRepository {
  constructor(private readonly transaction: DatabaseTransaction) {}

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
    await this.transaction.insert(schema.outboxMessages).values({
      taskId: input.id,
      topic: "runner.task.queued",
      payload: {
        version: "1",
        taskId: input.id,
        workspaceId: input.workspaceId,
      },
    });
    return { state: "created" };
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

    return renewed
      ? { state: "renewed", leaseExpiresAt: renewed.leaseExpiresAt }
      : { state: "stale" };
  }
}
