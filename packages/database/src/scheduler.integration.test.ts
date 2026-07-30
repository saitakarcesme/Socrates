import { randomUUID } from "node:crypto";

import { experimentTaskV2Schema } from "@socrates/contracts";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPersistence } from "./persistence";
import type {
  ClaimRunnerTaskResult,
  Persistence,
  RunnerRegistrationWrite,
  RunnerTaskWrite,
} from "./ports";
import {
  experiments,
  metricDefinitions,
  outboxMessages,
  projects,
  runnerTaskAttempts,
  runnerTaskCancellations,
  runnerTasks,
  runs,
  workspaces,
} from "./schema/index";

const connectionString = process.env["DATABASE_URL"];
const integration = describe.skipIf(!connectionString);

const capabilities = [
  {
    kind: "sandbox.oci",
    platform: "linux",
    architecture: "amd64",
  },
  { kind: "action.command", shell: false },
  { kind: "network.egress", mode: "disabled" },
] as const;

integration("PostgreSQL scheduler persistence", () => {
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const projectId = randomUUID();
  const metricDefinitionId = randomUUID();
  const runId = randomUUID();
  const experimentIds = Array.from({ length: 16 }, () => randomUUID());
  const runnerId = randomUUID();
  const secondRunnerId = randomUUID();
  const foreignRunnerId = randomUUID();

  let persistence: Persistence;
  let client: ReturnType<typeof postgres>;
  let database: ReturnType<typeof drizzle>;

  const registration = (
    id: string,
    scope = workspaceId,
    maximumConcurrentTasks = 10,
  ): RunnerRegistrationWrite => ({
    id,
    workspaceId: scope,
    kind: "local",
    softwareVersion: "0.1.0",
    taskProtocolVersions: ["2"],
    eventProtocolVersions: ["2"],
    sandboxBackend: "oci",
    capabilities,
    maximumConcurrentTasks,
  });

  const task = (
    id: string,
    experimentId: string,
    retrySafe = true,
  ): RunnerTaskWrite => ({
    id,
    workspaceId,
    projectId,
    runId,
    experimentId,
    expectedExperimentVersion: 0,
    protocolVersion: "2",
    payload: {
      version: "2",
      taskId: id,
      runId,
      experimentId,
      source: {
        snapshotId: randomUUID(),
        digest:
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      hypothesis: "A fenced lease prevents duplicate control.",
      action: {
        kind: "command-sequence",
        revision:
          "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        steps: [
          {
            executable: "/usr/bin/node",
            arguments: ["experiment.mjs"],
            workingDirectory: "/workspace",
            timeoutMs: 30_000,
          },
        ],
        retrySafe,
      },
      measurement: {
        metricDefinitionId,
        protocolRevision: 1,
        unit: "ms",
        direction: "minimize",
        minimumImprovement: "1",
        noiseTolerance: "0",
        command: {
          executable: "/usr/bin/node",
          arguments: ["measure.mjs"],
          workingDirectory: "/workspace",
          timeoutMs: 30_000,
        },
        result: {
          kind: "json-stdout",
          schema: "metric-value.v1",
          maximumBytes: 4096,
        },
      },
      constraints: [],
      environment: {
        imageDigest:
          "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        platform: "linux",
        architecture: "amd64",
        network: { mode: "disabled" },
        requiredCapabilities: capabilities,
      },
      budget: {
        wallTimeMs: 60_000,
        cpuTimeMs: 60_000,
        memoryBytes: 1_073_741_824,
        maximumPids: 128,
        writableBytes: 1_073_741_824,
        logBytes: 1_048_576,
        artifactBytes: 104_857_600,
        commandCount: 2,
        egressBytes: 0,
      },
    },
  });

  beforeAll(async () => {
    if (!connectionString) return;

    client = postgres(connectionString, { max: 4 });
    database = drizzle(client);
    persistence = createPersistence({
      connectionString,
      maximumConnections: 8,
    });

    await database.insert(workspaces).values([
      { id: workspaceId, name: "Scheduler workspace" },
      { id: otherWorkspaceId, name: "Foreign scheduler workspace" },
    ]);
    await database.insert(projects).values({
      id: projectId,
      workspaceId,
      name: "Scheduler project",
      slug: `scheduler-${projectId}`,
      objective: "Verify fenced task claims.",
    });
    await database.insert(metricDefinitions).values({
      id: metricDefinitionId,
      projectId,
      version: 1,
      name: "duration",
      unit: "ms",
      direction: "minimize",
      minimumImprovement: "1",
      noiseTolerance: "0",
    });
    await database.insert(runs).values({
      id: runId,
      projectId,
      metricDefinitionId,
      sequence: 1,
      title: "Scheduler run",
      objective: "Exercise task leases.",
    });
    await database.insert(experiments).values(
      experimentIds.map((id, index) => ({
        id,
        runId,
        sequence: index + 1,
        hypothesis: "A fenced lease prevents duplicate control.",
        action: "Claim one immutable task.",
        estimatedDurationMs: 60_000,
        estimatedCostMinor: 0,
      })),
    );

    await persistence.transaction(async ({ scheduler }) => {
      await scheduler.registerRunner(registration(runnerId));
      await scheduler.registerRunner(registration(secondRunnerId));
      await scheduler.registerRunner(
        registration(foreignRunnerId, otherWorkspaceId),
      );
    });
  });

  afterAll(async () => {
    await persistence?.close();
    await client?.end();
  });

  it("creates the immutable task and outbox message atomically", async () => {
    const taskId = randomUUID();
    await expect(
      persistence.transaction(({ scheduler }) =>
        scheduler.createTask(task(taskId, experimentIds[0]!)),
      ),
    ).resolves.toEqual({ state: "created" });

    const [storedTask] = await database
      .select({
        status: runnerTasks.status,
        fence: runnerTasks.currentFence,
        payload: runnerTasks.payload,
      })
      .from(runnerTasks)
      .where(eq(runnerTasks.id, taskId));
    const [message] = await database
      .select({
        topic: outboxMessages.topic,
        payload: outboxMessages.payload,
      })
      .from(outboxMessages)
      .where(eq(outboxMessages.taskId, taskId));

    expect(storedTask).toMatchObject({
      status: "queued",
      fence: 0,
      payload: { version: "2", taskId },
    });
    expect(message).toEqual({
      topic: "runner.task.queued",
      payload: { version: "1", taskId, workspaceId },
    });
    const [queuedExperiment] = await database
      .select({
        status: experiments.status,
        version: experiments.version,
      })
      .from(experiments)
      .where(eq(experiments.id, experimentIds[0]!));
    expect(queuedExperiment).toEqual({ status: "queued", version: 1 });
  });

  it("rolls back both task and outbox when the transaction fails", async () => {
    const taskId = randomUUID();
    await expect(
      persistence.transaction(async ({ scheduler }) => {
        await scheduler.createTask(task(taskId, experimentIds[1]!));
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");

    const stored = await database
      .select({ id: runnerTasks.id })
      .from(runnerTasks)
      .where(eq(runnerTasks.id, taskId));
    expect(stored).toHaveLength(0);
    const [rolledBackExperiment] = await database
      .select({
        status: experiments.status,
        version: experiments.version,
      })
      .from(experiments)
      .where(eq(experiments.id, experimentIds[1]!));
    expect(rolledBackExperiment).toEqual({ status: "proposed", version: 0 });
  });

  it("rejects a task whose validated payload identity diverges", async () => {
    const taskId = randomUUID();
    const write = task(taskId, experimentIds[1]!);
    const payload = experimentTaskV2Schema.parse(write.payload);

    await expect(
      persistence.transaction(({ scheduler }) =>
        scheduler.createTask({
          ...write,
          payload: { ...payload, taskId: randomUUID() },
        }),
      ),
    ).rejects.toThrow(
      "Runner task payload identity does not match its scheduling projection.",
    );
  });

  it("allows exactly one concurrent fenced claim", async () => {
    const taskId = randomUUID();
    await persistence.transaction(({ scheduler }) =>
      scheduler.createTask(task(taskId, experimentIds[2]!)),
    );

    const claimInputs = [
      {
        runnerId,
        taskId,
        attemptId: randomUUID(),
        leaseDurationMs: 30_000,
      },
      {
        runnerId: secondRunnerId,
        taskId,
        attemptId: randomUUID(),
        leaseDurationMs: 30_000,
      },
    ] as const;
    const claims = await Promise.all(
      claimInputs.map((input) =>
        persistence.transaction(({ scheduler }) => scheduler.claimTask(input)),
      ),
    );

    expect(claims.filter((claim) => claim.state === "claimed")).toHaveLength(1);
    expect(
      claims.filter((claim) => claim.state === "task_unavailable"),
    ).toHaveLength(1);

    const [storedTask] = await database
      .select({
        status: runnerTasks.status,
        fence: runnerTasks.currentFence,
      })
      .from(runnerTasks)
      .where(eq(runnerTasks.id, taskId));
    const attempts = await database
      .select({
        taskId: runnerTaskAttempts.taskId,
        fence: runnerTaskAttempts.fence,
      })
      .from(runnerTaskAttempts)
      .where(eq(runnerTaskAttempts.taskId, taskId));

    expect(storedTask).toEqual({ status: "leased", fence: 1 });
    expect(attempts).toEqual([{ taskId, fence: 1 }]);

    const winnerIndex = claims.findIndex((claim) => claim.state === "claimed");
    const winner = claims[winnerIndex] as Extract<
      ClaimRunnerTaskResult,
      { state: "claimed" }
    >;
    await expect(
      persistence.transaction(({ scheduler }) =>
        scheduler.claimTask(claimInputs[winnerIndex]!),
      ),
    ).resolves.toEqual(winner);
  });

  it("renews only the current unexpired fence", async () => {
    const taskId = randomUUID();
    const attemptId = randomUUID();
    await persistence.transaction(({ scheduler }) =>
      scheduler.createTask(task(taskId, experimentIds[3]!)),
    );
    const claim = await persistence.transaction(({ scheduler }) =>
      scheduler.claimTask({
        runnerId: secondRunnerId,
        taskId,
        attemptId,
        leaseDurationMs: 30_000,
      }),
    );
    expect(claim.state).toBe("claimed");
    const fence = (
      claim as Extract<ClaimRunnerTaskResult, { state: "claimed" }>
    ).claim.fence;

    await expect(
      persistence.transaction(({ scheduler }) =>
        scheduler.heartbeat({
          runnerId: secondRunnerId,
          taskId,
          attemptId,
          fence,
          leaseDurationMs: 60_000,
        }),
      ),
    ).resolves.toMatchObject({ state: "renewed" });
    await expect(
      persistence.transaction(({ scheduler }) =>
        scheduler.heartbeat({
          runnerId: secondRunnerId,
          taskId,
          attemptId,
          fence: fence + 1,
          leaseDurationMs: 60_000,
        }),
      ),
    ).resolves.toEqual({ state: "stale" });
    await persistence.transaction(({ scheduler }) =>
      scheduler.reconcileExpiredTasks({ limit: 100 }),
    );

    await database
      .update(runnerTaskAttempts)
      .set({ leaseExpiresAt: new Date(0) })
      .where(eq(runnerTaskAttempts.id, attemptId));
    await expect(
      persistence.transaction(({ scheduler }) =>
        scheduler.heartbeat({
          runnerId: secondRunnerId,
          taskId,
          attemptId,
          fence,
          leaseDurationMs: 60_000,
        }),
      ),
    ).resolves.toEqual({ state: "stale" });
  });

  it("hides tasks across workspace boundaries", async () => {
    const taskId = randomUUID();
    await persistence.transaction(({ scheduler }) =>
      scheduler.createTask(task(taskId, experimentIds[4]!)),
    );

    await expect(
      persistence.transaction(({ scheduler }) =>
        scheduler.claimTask({
          runnerId: foreignRunnerId,
          taskId,
          attemptId: randomUUID(),
          leaseDurationMs: 30_000,
        }),
      ),
    ).resolves.toEqual({ state: "task_not_found" });
  });

  it("denies a claim when a required capability is unavailable", async () => {
    const taskId = randomUUID();
    const taskWrite = task(taskId, experimentIds[5]!);
    const payload = experimentTaskV2Schema.parse(taskWrite.payload);
    await persistence.transaction(({ scheduler }) =>
      scheduler.createTask({
        ...taskWrite,
        payload: {
          ...payload,
          environment: {
            imageDigest:
              "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            platform: "linux",
            architecture: "amd64",
            network: {
              mode: "allowlist",
              destinations: [{ host: "example.com", ports: [443] }],
            },
            requiredCapabilities: [
              ...capabilities.slice(0, 2),
              { kind: "network.egress", mode: "allowlist" },
            ],
          },
          budget: {
            wallTimeMs: 60_000,
            cpuTimeMs: 60_000,
            memoryBytes: 1_073_741_824,
            maximumPids: 128,
            writableBytes: 1_073_741_824,
            logBytes: 1_048_576,
            artifactBytes: 104_857_600,
            commandCount: 2,
            egressBytes: 1_048_576,
          },
        },
      }),
    );

    await expect(
      persistence.transaction(({ scheduler }) =>
        scheduler.claimTask({
          runnerId,
          taskId,
          attemptId: randomUUID(),
          leaseDurationMs: 30_000,
        }),
      ),
    ).resolves.toEqual({ state: "capability_mismatch" });
  });

  it("serializes claims through runner capacity", async () => {
    const capacityRunnerId = randomUUID();
    const firstTaskId = randomUUID();
    const secondTaskId = randomUUID();
    await persistence.transaction(async ({ scheduler }) => {
      await scheduler.registerRunner(
        registration(capacityRunnerId, workspaceId, 1),
      );
      await scheduler.createTask(task(firstTaskId, experimentIds[6]!));
      await scheduler.createTask(task(secondTaskId, experimentIds[7]!));
    });

    await expect(
      persistence.transaction(({ scheduler }) =>
        scheduler.claimTask({
          runnerId: capacityRunnerId,
          taskId: firstTaskId,
          attemptId: randomUUID(),
          leaseDurationMs: 30_000,
        }),
      ),
    ).resolves.toMatchObject({ state: "claimed" });
    await expect(
      persistence.transaction(({ scheduler }) =>
        scheduler.claimTask({
          runnerId: capacityRunnerId,
          taskId: secondTaskId,
          attemptId: randomUUID(),
          leaseDurationMs: 30_000,
        }),
      ),
    ).resolves.toEqual({ state: "runner_at_capacity" });
  });

  it("persists a queued cancellation once and replays its acceptance", async () => {
    const taskId = randomUUID();
    const requestId = randomUUID();
    await persistence.transaction(({ scheduler }) =>
      scheduler.createTask(task(taskId, experimentIds[8]!)),
    );

    const accepted = await persistence.transaction(({ scheduler }) =>
      scheduler.requestCancellation({ requestId, workspaceId, taskId }),
    );
    expect(accepted).toMatchObject({
      state: "accepted",
      cancellation: { requestId, taskId, taskStatus: "cancelled" },
    });
    await expect(
      persistence.transaction(({ scheduler }) =>
        scheduler.requestCancellation({
          requestId: randomUUID(),
          workspaceId,
          taskId,
        }),
      ),
    ).resolves.toEqual(accepted);

    const [storedTask] = await database
      .select({
        status: runnerTasks.status,
        cancellationRequestedAt: runnerTasks.cancellationRequestedAt,
        terminalAt: runnerTasks.terminalAt,
      })
      .from(runnerTasks)
      .where(eq(runnerTasks.id, taskId));
    const cancellations = await database
      .select()
      .from(runnerTaskCancellations)
      .where(eq(runnerTaskCancellations.taskId, taskId));
    const messages = await database
      .select({ topic: outboxMessages.topic })
      .from(outboxMessages)
      .where(eq(outboxMessages.taskId, taskId));

    expect(storedTask).toMatchObject({ status: "cancelled" });
    expect(storedTask?.cancellationRequestedAt).toBeInstanceOf(Date);
    expect(storedTask?.terminalAt).toBeInstanceOf(Date);
    expect(cancellations).toHaveLength(1);
    expect(messages.map(({ topic }) => topic)).toEqual([
      "runner.task.queued",
      "runner.task.cancelled",
    ]);
  });

  it("allows only one fenced terminal result after cancellation", async () => {
    const taskId = randomUUID();
    const attemptId = randomUUID();
    await persistence.transaction(({ scheduler }) =>
      scheduler.createTask(task(taskId, experimentIds[9]!)),
    );
    const claim = await persistence.transaction(({ scheduler }) =>
      scheduler.claimTask({
        runnerId,
        taskId,
        attemptId,
        leaseDurationMs: 30_000,
      }),
    );
    expect(claim.state).toBe("claimed");
    const fence = (
      claim as Extract<ClaimRunnerTaskResult, { state: "claimed" }>
    ).claim.fence;
    await persistence.transaction(({ scheduler }) =>
      scheduler.requestCancellation({
        requestId: randomUUID(),
        workspaceId,
        taskId,
      }),
    );

    const completions = await Promise.all([
      persistence.transaction(({ scheduler }) =>
        scheduler.completeTask({
          runnerId,
          taskId,
          attemptId,
          fence,
          outcome: { status: "cancelled" },
        }),
      ),
      persistence.transaction(({ scheduler }) =>
        scheduler.completeTask({
          runnerId,
          taskId,
          attemptId,
          fence,
          outcome: { status: "failed", failureClassification: "runner_error" },
        }),
      ),
    ]);

    expect(
      completions.filter((completion) => completion.state === "completed"),
    ).toHaveLength(1);
    expect(
      completions.filter((completion) => completion.state === "stale"),
    ).toHaveLength(1);

    const [storedTask] = await database
      .select({ status: runnerTasks.status })
      .from(runnerTasks)
      .where(eq(runnerTasks.id, taskId));
    const [storedAttempt] = await database
      .select({
        status: runnerTaskAttempts.status,
        completedAt: runnerTaskAttempts.completedAt,
      })
      .from(runnerTaskAttempts)
      .where(eq(runnerTaskAttempts.id, attemptId));
    expect(["cancelled", "failed"]).toContain(storedTask?.status);
    expect(storedAttempt?.status).toBe(storedTask?.status);
    expect(storedAttempt?.completedAt).toBeInstanceOf(Date);
    const messages = await database
      .select({ topic: outboxMessages.topic })
      .from(outboxMessages)
      .where(eq(outboxMessages.taskId, taskId));
    expect(messages.map(({ topic }) => topic)).toContain(
      `runner.task.${storedTask?.status}`,
    );
  });

  it("rejects terminal writes after the database lease expires", async () => {
    const taskId = randomUUID();
    const attemptId = randomUUID();
    await persistence.transaction(({ scheduler }) =>
      scheduler.createTask(task(taskId, experimentIds[10]!)),
    );
    const claim = await persistence.transaction(({ scheduler }) =>
      scheduler.claimTask({
        runnerId,
        taskId,
        attemptId,
        leaseDurationMs: 30_000,
      }),
    );
    const fence = (
      claim as Extract<ClaimRunnerTaskResult, { state: "claimed" }>
    ).claim.fence;
    await database
      .update(runnerTaskAttempts)
      .set({ leaseExpiresAt: new Date(0) })
      .where(eq(runnerTaskAttempts.id, attemptId));

    await expect(
      persistence.transaction(({ scheduler }) =>
        scheduler.completeTask({
          runnerId,
          taskId,
          attemptId,
          fence,
          outcome: { status: "failed", failureClassification: "timeout" },
        }),
      ),
    ).resolves.toEqual({ state: "stale" });
    await persistence.transaction(({ scheduler }) =>
      scheduler.reconcileExpiredTasks({ limit: 100 }),
    );
  });

  it("expires and requeues only retry-safe tasks with a new claim fence", async () => {
    const taskId = randomUUID();
    const attemptId = randomUUID();
    await persistence.transaction(({ scheduler }) =>
      scheduler.createTask(task(taskId, experimentIds[11]!)),
    );
    const firstClaim = await persistence.transaction(({ scheduler }) =>
      scheduler.claimTask({
        runnerId,
        taskId,
        attemptId,
        leaseDurationMs: 30_000,
      }),
    );
    const firstFence = (
      firstClaim as Extract<ClaimRunnerTaskResult, { state: "claimed" }>
    ).claim.fence;
    await database
      .update(runnerTaskAttempts)
      .set({ leaseExpiresAt: new Date(0) })
      .where(eq(runnerTaskAttempts.id, attemptId));

    await expect(
      persistence.transaction(({ scheduler }) =>
        scheduler.reconcileExpiredTasks({ limit: 10 }),
      ),
    ).resolves.toEqual({
      reconciled: [{ taskId, attemptId, outcome: "requeued" }],
    });
    const secondClaim = await persistence.transaction(({ scheduler }) =>
      scheduler.claimTask({
        runnerId,
        taskId,
        attemptId: randomUUID(),
        leaseDurationMs: 30_000,
      }),
    );

    expect(secondClaim).toMatchObject({
      state: "claimed",
      claim: { fence: firstFence + 1 },
    });
    const [expiredAttempt] = await database
      .select({
        status: runnerTaskAttempts.status,
        completedAt: runnerTaskAttempts.completedAt,
      })
      .from(runnerTaskAttempts)
      .where(eq(runnerTaskAttempts.id, attemptId));
    expect(expiredAttempt?.status).toBe("expired");
    expect(expiredAttempt?.completedAt).toBeInstanceOf(Date);
    const messages = await database
      .select({ topic: outboxMessages.topic })
      .from(outboxMessages)
      .where(eq(outboxMessages.taskId, taskId));
    expect(messages.map(({ topic }) => topic)).toContain(
      "runner.task.requeued",
    );
  });

  it("fails an expired task that is not retry-safe", async () => {
    const taskId = randomUUID();
    const attemptId = randomUUID();
    await persistence.transaction(({ scheduler }) =>
      scheduler.createTask(task(taskId, experimentIds[12]!, false)),
    );
    await persistence.transaction(({ scheduler }) =>
      scheduler.claimTask({
        runnerId,
        taskId,
        attemptId,
        leaseDurationMs: 30_000,
      }),
    );
    await database
      .update(runnerTaskAttempts)
      .set({ leaseExpiresAt: new Date(0) })
      .where(eq(runnerTaskAttempts.id, attemptId));

    await expect(
      persistence.transaction(({ scheduler }) =>
        scheduler.reconcileExpiredTasks({ limit: 1 }),
      ),
    ).resolves.toEqual({
      reconciled: [{ taskId, attemptId, outcome: "failed" }],
    });
    const [storedTask] = await database
      .select({
        status: runnerTasks.status,
        terminalAt: runnerTasks.terminalAt,
      })
      .from(runnerTasks)
      .where(eq(runnerTasks.id, taskId));
    expect(storedTask?.status).toBe("failed");
    expect(storedTask?.terminalAt).toBeInstanceOf(Date);
  });

  it("turns an expired cancellation request into a final cancellation", async () => {
    const taskId = randomUUID();
    const attemptId = randomUUID();
    await persistence.transaction(({ scheduler }) =>
      scheduler.createTask(task(taskId, experimentIds[13]!)),
    );
    await persistence.transaction(({ scheduler }) =>
      scheduler.claimTask({
        runnerId,
        taskId,
        attemptId,
        leaseDurationMs: 30_000,
      }),
    );
    await persistence.transaction(({ scheduler }) =>
      scheduler.requestCancellation({
        requestId: randomUUID(),
        workspaceId,
        taskId,
      }),
    );
    await database
      .update(runnerTaskAttempts)
      .set({ leaseExpiresAt: new Date(0) })
      .where(eq(runnerTaskAttempts.id, attemptId));

    await expect(
      persistence.transaction(({ scheduler }) =>
        scheduler.reconcileExpiredTasks({ limit: 10 }),
      ),
    ).resolves.toEqual({
      reconciled: [{ taskId, attemptId, outcome: "cancelled" }],
    });
  });

  it("rejects reuse of a cancellation request ID for another task", async () => {
    const requestId = randomUUID();
    const firstTaskId = randomUUID();
    const secondTaskId = randomUUID();
    await persistence.transaction(async ({ scheduler }) => {
      await scheduler.createTask(task(firstTaskId, experimentIds[14]!));
      await scheduler.createTask(task(secondTaskId, experimentIds[15]!));
    });
    await persistence.transaction(({ scheduler }) =>
      scheduler.requestCancellation({
        requestId,
        workspaceId,
        taskId: firstTaskId,
      }),
    );

    await expect(
      persistence.transaction(({ scheduler }) =>
        scheduler.requestCancellation({
          requestId,
          workspaceId,
          taskId: secondTaskId,
        }),
      ),
    ).resolves.toEqual({ state: "request_conflict" });
  });
});
