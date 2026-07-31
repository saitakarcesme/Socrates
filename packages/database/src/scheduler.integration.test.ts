import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalContentAddressedArtifactStore } from "@socrates/artifact-store/local";
import { experimentTaskV2Schema, type RunnerBudget } from "@socrates/contracts";
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPersistence } from "./persistence";
import type { RunnerEventV2 } from "@socrates/contracts";
import type {
  ClaimRunnerTaskResult,
  Persistence,
  RunnerRegistrationWrite,
  RunnerTaskWrite,
} from "./ports";
import {
  experiments,
  artifactObjects,
  metricDefinitions,
  outboxMessages,
  projects,
  runEvents,
  runnerTaskAttempts,
  runnerTaskArtifacts,
  runnerTaskCancellations,
  runnerTaskDeliveries,
  runnerTaskEvents,
  runnerTasks,
  runnerRegistrationTokens,
  runs,
  sourceSnapshots,
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

function contentDigest(content: Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

async function* binaryChunks(content: Uint8Array) {
  yield content;
}

integration("PostgreSQL scheduler persistence", () => {
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const projectId = randomUUID();
  const metricDefinitionId = randomUUID();
  const runId = randomUUID();
  const experimentIds = Array.from({ length: 24 }, () => randomUUID());
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
    budgetOverrides: Partial<RunnerBudget> = {},
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
        ...budgetOverrides,
      },
    },
  });

  const claimForEvents = async (
    experimentIndex: number,
    budgetOverrides: Partial<RunnerBudget> = {},
  ) => {
    const taskId = randomUUID();
    const attemptId = randomUUID();
    await persistence.transaction(({ scheduler }) =>
      scheduler.createTask(
        task(taskId, experimentIds[experimentIndex]!, true, budgetOverrides),
      ),
    );
    const result = await persistence.transaction(({ scheduler }) =>
      scheduler.claimTask({
        runnerId,
        taskId,
        attemptId,
        leaseDurationMs: 120_000,
      }),
    );
    if (result.state !== "claimed") {
      throw new Error(`Expected event test claim, received ${result.state}.`);
    }
    return { taskId, attemptId, fence: result.claim.fence };
  };

  const eventEnvelope = (
    claim: Awaited<ReturnType<typeof claimForEvents>>,
    sequence: number,
    eventId = randomUUID(),
  ) => ({
    version: "2" as const,
    eventId,
    runnerId,
    taskId: claim.taskId,
    attemptId: claim.attemptId,
    fence: claim.fence,
    sequence,
    occurredAt: "2026-07-31T00:00:00.000Z",
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

  it("provisions only hashed credentials and evaluates revocation with database time", async () => {
    const tokenId = randomUUID();
    const secretDigest = "a".repeat(64);
    const input = {
      tokenId,
      runnerId,
      secretDigest,
      label: "scheduler integration",
      expiresAt: new Date(Date.now() + 60_000),
    };

    await expect(
      persistence.runnerCredentials.provision(input),
    ).resolves.toEqual({ state: "created" });
    await expect(
      persistence.runnerCredentials.provision(input),
    ).resolves.toEqual({ state: "token_conflict" });
    await expect(
      persistence.runnerCredentials.findCandidate(tokenId),
    ).resolves.toEqual({
      tokenId,
      runnerId,
      workspaceId,
      secretDigest,
      usable: true,
    });

    await database
      .update(runnerRegistrationTokens)
      .set({ revokedAt: new Date() })
      .where(eq(runnerRegistrationTokens.id, tokenId));
    await expect(
      persistence.runnerCredentials.findCandidate(tokenId),
    ).resolves.toMatchObject({ tokenId, usable: false });
    await expect(
      persistence.runnerCredentials.findCandidate(randomUUID()),
    ).resolves.toBeNull();
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

  it("reserves one task once and claims only through its exact delivery", async () => {
    const deliveryWorkspaceId = randomUUID();
    const deliveryProjectId = randomUUID();
    const deliveryMetricId = randomUUID();
    const deliveryRunId = randomUUID();
    const deliveryExperimentId = randomUUID();
    const firstDeliveryRunner = randomUUID();
    const secondDeliveryRunner = randomUUID();
    const taskId = randomUUID();
    await database.insert(workspaces).values({
      id: deliveryWorkspaceId,
      name: "Isolated delivery workspace",
    });
    await database.insert(projects).values({
      id: deliveryProjectId,
      workspaceId: deliveryWorkspaceId,
      name: "Delivery project",
      slug: `delivery-${deliveryProjectId}`,
      objective: "Isolate concurrent delivery acquisition.",
    });
    await database.insert(metricDefinitions).values({
      id: deliveryMetricId,
      projectId: deliveryProjectId,
      version: 1,
      name: "delivery-duration",
      unit: "ms",
      direction: "minimize",
      minimumImprovement: "1",
      noiseTolerance: "0",
    });
    await database.insert(runs).values({
      id: deliveryRunId,
      projectId: deliveryProjectId,
      metricDefinitionId: deliveryMetricId,
      sequence: 1,
      title: "Delivery run",
      objective: "Reserve one task exactly once.",
    });
    await database.insert(experiments).values({
      id: deliveryExperimentId,
      runId: deliveryRunId,
      sequence: 1,
      hypothesis: "A fenced offer has one owner.",
      action: "Acquire concurrently.",
      estimatedDurationMs: 60_000,
      estimatedCostMinor: 0,
    });
    const deliveryTask = (
      deliveryTaskId: string,
      experimentId: string,
    ): RunnerTaskWrite => {
      const baseTask = task(deliveryTaskId, experimentId);
      const basePayload = experimentTaskV2Schema.parse(baseTask.payload);
      return {
        ...baseTask,
        workspaceId: deliveryWorkspaceId,
        projectId: deliveryProjectId,
        runId: deliveryRunId,
        experimentId,
        payload: {
          ...basePayload,
          runId: deliveryRunId,
          experimentId,
          measurement: {
            ...basePayload.measurement,
            metricDefinitionId: deliveryMetricId,
          },
        },
      };
    };
    await persistence.transaction(async ({ scheduler }) => {
      await scheduler.registerRunner(
        registration(firstDeliveryRunner, deliveryWorkspaceId),
      );
      await scheduler.registerRunner(
        registration(secondDeliveryRunner, deliveryWorkspaceId),
      );
      await scheduler.createTask(deliveryTask(taskId, deliveryExperimentId));
    });

    await expect(
      persistence.transaction(({ scheduler }) =>
        scheduler.acquireTaskDelivery({
          runnerId: firstDeliveryRunner,
          offerDurationMs: 0,
        }),
      ),
    ).rejects.toThrow(RangeError);
    await expect(
      persistence.transaction(({ scheduler }) =>
        scheduler.reconcileExpiredTaskDeliveries({ limit: 0 }),
      ),
    ).rejects.toThrow(RangeError);

    const offers = await Promise.all(
      [firstDeliveryRunner, secondDeliveryRunner].map((candidateRunnerId) =>
        persistence.transaction(({ scheduler }) =>
          scheduler.acquireTaskDelivery({
            runnerId: candidateRunnerId,
            offerDurationMs: 60_000,
          }),
        ),
      ),
    );
    const acquired = offers.filter((offer) => offer.state === "acquired");
    expect(acquired).toHaveLength(1);
    const winner = acquired[0]!;
    if (winner.state !== "acquired") throw new Error("Expected one offer.");
    const winnerRunner =
      offers[0] === winner ? firstDeliveryRunner : secondDeliveryRunner;

    await expect(
      persistence.transaction(({ scheduler }) =>
        scheduler.acquireTaskDelivery({
          runnerId: winnerRunner,
          offerDurationMs: 60_000,
        }),
      ),
    ).resolves.toEqual(winner);

    const attemptId = randomUUID();
    const staleClaimInput = {
      runnerId: winnerRunner,
      deliveryId: winner.delivery.deliveryId,
      taskId,
      attemptId,
      leaseDurationMs: 30_000,
    };
    const [offered] = await database
      .select({
        offeredAt: runnerTaskDeliveries.offeredAt,
        expiresAt: runnerTaskDeliveries.expiresAt,
      })
      .from(runnerTaskDeliveries)
      .where(eq(runnerTaskDeliveries.id, winner.delivery.deliveryId));
    expect(offered!.expiresAt.getTime()).toBeGreaterThan(
      offered!.offeredAt.getTime(),
    );
    await database
      .update(runnerTaskDeliveries)
      .set({
        expiresAt: sql`${runnerTaskDeliveries.offeredAt} + INTERVAL '1 microsecond'`,
      })
      .where(eq(runnerTaskDeliveries.id, winner.delivery.deliveryId));
    await expect(
      persistence.transaction(({ scheduler }) =>
        scheduler.acquireTaskDelivery({
          runnerId: winnerRunner,
          offerDurationMs: 60_000,
        }),
      ),
    ).resolves.toEqual({ state: "none" });
    const reconciliation = await persistence.transaction(({ scheduler }) =>
      scheduler.reconcileExpiredTaskDeliveries({ limit: 1 }),
    );
    expect(reconciliation).toEqual({
      revoked: [
        {
          deliveryId: winner.delivery.deliveryId,
          taskId,
          runnerId: winnerRunner,
          reason: "expired",
        },
      ],
    });
    await expect(
      persistence.transaction(({ scheduler }) =>
        scheduler.claimTaskDelivery(staleClaimInput),
      ),
    ).resolves.toEqual({ state: "delivery_conflict" });

    const replacementRunner =
      winnerRunner === firstDeliveryRunner
        ? secondDeliveryRunner
        : firstDeliveryRunner;
    const replacement = await persistence.transaction(({ scheduler }) =>
      scheduler.acquireTaskDelivery({
        runnerId: replacementRunner,
        offerDurationMs: 60_000,
      }),
    );
    expect(replacement).toMatchObject({
      state: "acquired",
      delivery: { taskId },
    });
    if (replacement.state !== "acquired") {
      throw new Error("Expected a replacement offer.");
    }
    expect(replacement.delivery.deliveryId).not.toBe(
      winner.delivery.deliveryId,
    );
    const claimInput = {
      ...staleClaimInput,
      runnerId: replacementRunner,
      deliveryId: replacement.delivery.deliveryId,
    };
    const claim = await persistence.transaction(({ scheduler }) =>
      scheduler.claimTaskDelivery(claimInput),
    );
    expect(claim).toMatchObject({
      state: "claimed",
      claim: { taskId, attemptId, fence: 1 },
    });
    await expect(
      persistence.transaction(({ scheduler }) =>
        scheduler.claimTaskDelivery(claimInput),
      ),
    ).resolves.toEqual(claim);
    await expect(
      persistence.transaction(({ scheduler }) =>
        scheduler.claimTaskDelivery({ ...claimInput, attemptId: randomUUID() }),
      ),
    ).resolves.toEqual({ state: "delivery_conflict" });

    await database
      .update(runnerTaskDeliveries)
      .set({
        expiresAt: sql`${runnerTaskDeliveries.offeredAt} + INTERVAL '1 microsecond'`,
      })
      .where(eq(runnerTaskDeliveries.id, replacement.delivery.deliveryId));
    await expect(
      persistence.transaction(({ scheduler }) =>
        scheduler.reconcileExpiredTaskDeliveries({ limit: 10 }),
      ),
    ).resolves.toEqual({ revoked: [] });

    const [storedDelivery] = await database
      .select({
        state: runnerTaskDeliveries.state,
        attemptId: runnerTaskDeliveries.attemptId,
        fence: runnerTaskDeliveries.fence,
      })
      .from(runnerTaskDeliveries)
      .where(eq(runnerTaskDeliveries.id, replacement.delivery.deliveryId));
    const [message] = await database
      .select({ publishedAt: outboxMessages.publishedAt })
      .from(outboxMessages)
      .where(eq(outboxMessages.taskId, taskId));
    expect(storedDelivery).toEqual({ state: "claimed", attemptId, fence: 1 });
    expect(message).toEqual({ publishedAt: null });

    const batchExperimentIds = [randomUUID(), randomUUID()];
    const batchTaskIds = [randomUUID(), randomUUID()];
    await database.insert(experiments).values(
      batchExperimentIds.map((id, index) => ({
        id,
        runId: deliveryRunId,
        sequence: index + 2,
        hypothesis: "Expired offers are partitioned across reconcilers.",
        action: "Revoke one bounded batch.",
        estimatedDurationMs: 60_000,
        estimatedCostMinor: 0,
      })),
    );
    await persistence.transaction(async ({ scheduler }) => {
      for (const [index, batchTaskId] of batchTaskIds.entries()) {
        await scheduler.createTask(
          deliveryTask(batchTaskId!, batchExperimentIds[index]!),
        );
      }
    });
    const batchOffers = [];
    for (const candidateRunnerId of [
      firstDeliveryRunner,
      secondDeliveryRunner,
    ]) {
      batchOffers.push(
        await persistence.transaction(({ scheduler }) =>
          scheduler.acquireTaskDelivery({
            runnerId: candidateRunnerId,
            offerDurationMs: 60_000,
          }),
        ),
      );
    }
    expect(batchOffers.every((offer) => offer.state === "acquired")).toBe(true);
    const batchDeliveryIds = batchOffers.flatMap((offer) =>
      offer.state === "acquired" ? [offer.delivery.deliveryId] : [],
    );
    await database
      .update(runnerTaskDeliveries)
      .set({
        expiresAt: sql`${runnerTaskDeliveries.offeredAt} + INTERVAL '1 microsecond'`,
      })
      .where(inArray(runnerTaskDeliveries.id, batchDeliveryIds));
    const batches = await Promise.all([
      persistence.transaction(({ scheduler }) =>
        scheduler.reconcileExpiredTaskDeliveries({ limit: 1 }),
      ),
      persistence.transaction(({ scheduler }) =>
        scheduler.reconcileExpiredTaskDeliveries({ limit: 1 }),
      ),
    ]);
    const revokedIds = batches.flatMap((batch) =>
      batch.revoked.map((delivery) => delivery.deliveryId),
    );
    expect(revokedIds).toHaveLength(2);
    expect(new Set(revokedIds)).toEqual(new Set(batchDeliveryIds));
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
    ).resolves.toMatchObject({ state: "renewed", directive: "continue" });
    await persistence.transaction(({ scheduler }) =>
      scheduler.requestCancellation({
        requestId: randomUUID(),
        workspaceId,
        taskId,
        gracePeriodMs: 750,
        reason: "budget",
      }),
    );
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
    ).resolves.toMatchObject({
      state: "renewed",
      directive: "cancel",
      cancellation: { gracePeriodMs: 750, reason: "budget" },
    });
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
      scheduler.requestCancellation({
        requestId,
        workspaceId,
        taskId,
        gracePeriodMs: 5_000,
        reason: "operator",
      }),
    );
    expect(accepted).toMatchObject({
      state: "accepted",
      cancellation: {
        requestId,
        taskId,
        taskStatus: "cancelled",
        gracePeriodMs: 5_000,
        reason: "operator",
      },
    });
    await expect(
      persistence.transaction(({ scheduler }) =>
        scheduler.requestCancellation({
          requestId: randomUUID(),
          workspaceId,
          taskId,
          gracePeriodMs: 1,
          reason: "policy",
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
    expect(cancellations[0]).toMatchObject({
      gracePeriodMs: 5_000,
      reason: "operator",
    });
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
        gracePeriodMs: 5_000,
        reason: "operator",
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
        gracePeriodMs: 5_000,
        reason: "operator",
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
        gracePeriodMs: 5_000,
        reason: "operator",
      }),
    );

    await expect(
      persistence.transaction(({ scheduler }) =>
        scheduler.requestCancellation({
          requestId,
          workspaceId,
          taskId: secondTaskId,
          gracePeriodMs: 5_000,
          reason: "operator",
        }),
      ),
    ).resolves.toEqual({ state: "request_conflict" });
  });

  it("acknowledges an ordered lifecycle and atomically projects terminal evidence", async () => {
    const claim = await claimForEvents(16);
    const prepared = {
      ...eventEnvelope(claim, 1),
      type: "workspace.prepared" as const,
      payload: {
        sourceDigest:
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        imageDigest:
          "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      },
    };
    const preparedResults = await Promise.all([
      persistence.transaction(({ scheduler }) =>
        scheduler.ingestEvent({ event: prepared }),
      ),
      persistence.transaction(({ scheduler }) =>
        scheduler.ingestEvent({ event: prepared }),
      ),
    ]);
    expect(preparedResults.map(({ state }) => state).sort()).toEqual([
      "accepted",
      "replay",
    ]);
    for (const result of preparedResults) {
      expect(result).toMatchObject({
        acknowledgement: {
          eventId: prepared.eventId,
          acknowledgedSequence: 1,
          expectedSequence: 2,
        },
      });
    }

    const lifecycleEvents: RunnerEventV2[] = [
      {
        ...eventEnvelope(claim, 2),
        type: "action.started" as const,
        payload: { commandIndex: 0 },
      },
      {
        ...eventEnvelope(claim, 3),
        type: "action.completed" as const,
        payload: { commandIndex: 0, exitCode: 0, durationMs: 1200 },
      },
      {
        ...eventEnvelope(claim, 4),
        type: "measurement.recorded" as const,
        payload: {
          metricDefinitionId,
          amount: "99",
          unit: "ms",
          sampleCount: 1,
        },
      },
      {
        ...eventEnvelope(claim, 5),
        type: "task.succeeded" as const,
        payload: { exitCode: 0 as const, durationMs: 1500 },
      },
    ];
    for (const event of lifecycleEvents) {
      await expect(
        persistence.transaction(({ scheduler }) =>
          scheduler.ingestEvent({ event }),
        ),
      ).resolves.toMatchObject({
        state: "accepted",
        acknowledgement: {
          eventId: event.eventId,
          acknowledgedSequence: event.sequence,
          expectedSequence: event.sequence + 1,
        },
      });
    }

    const terminalEvent = lifecycleEvents[3]!;
    await expect(
      persistence.transaction(({ scheduler }) =>
        scheduler.ingestEvent({ event: terminalEvent }),
      ),
    ).resolves.toMatchObject({
      state: "replay",
      acknowledgement: {
        eventId: terminalEvent.eventId,
        acknowledgedSequence: 5,
      },
    });

    const storedEvents = await database
      .select({
        type: runnerTaskEvents.type,
        sequence: runnerTaskEvents.sequence,
      })
      .from(runnerTaskEvents)
      .where(eq(runnerTaskEvents.attemptId, claim.attemptId))
      .orderBy(runnerTaskEvents.sequence);
    expect(storedEvents).toEqual([
      { type: "workspace.prepared", sequence: 1 },
      { type: "action.started", sequence: 2 },
      { type: "action.completed", sequence: 3 },
      { type: "measurement.recorded", sequence: 4 },
      { type: "task.succeeded", sequence: 5 },
    ]);

    const [attempt] = await database
      .select({
        status: runnerTaskAttempts.status,
        sequence: runnerTaskAttempts.lastEventSequence,
        completedAt: runnerTaskAttempts.completedAt,
      })
      .from(runnerTaskAttempts)
      .where(eq(runnerTaskAttempts.id, claim.attemptId));
    const [storedTask] = await database
      .select({
        status: runnerTasks.status,
        terminalAt: runnerTasks.terminalAt,
      })
      .from(runnerTasks)
      .where(eq(runnerTasks.id, claim.taskId));
    expect(attempt).toMatchObject({ status: "succeeded", sequence: 5 });
    expect(attempt?.completedAt).toBeInstanceOf(Date);
    expect(storedTask?.status).toBe("succeeded");
    expect(storedTask?.terminalAt).toBeInstanceOf(Date);

    const projected = await database
      .select({ type: runEvents.type })
      .from(runEvents)
      .where(eq(runEvents.runId, runId));
    expect(
      projected.filter(({ type }) => type.startsWith("runner.")),
    ).toHaveLength(5);
  });

  it("rejects gaps and conflicting identities without advancing the cursor", async () => {
    const claim = await claimForEvents(17);
    const payload = {
      sourceDigest:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      imageDigest:
        "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    };
    const firstEvent = {
      ...eventEnvelope(claim, 1),
      type: "workspace.prepared" as const,
      payload,
    };

    await expect(
      persistence.transaction(({ scheduler }) =>
        scheduler.ingestEvent({
          event: {
            ...eventEnvelope(claim, 2),
            type: "workspace.prepared",
            payload,
          },
        }),
      ),
    ).resolves.toEqual({ state: "gap", expectedSequence: 1 });
    await persistence.transaction(({ scheduler }) =>
      scheduler.ingestEvent({ event: firstEvent }),
    );
    await expect(
      persistence.transaction(({ scheduler }) =>
        scheduler.ingestEvent({
          event: {
            ...firstEvent,
            payload: {
              ...payload,
              sourceDigest:
                "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            },
          },
        }),
      ),
    ).resolves.toEqual({ state: "event_conflict" });
    await expect(
      persistence.transaction(({ scheduler }) =>
        scheduler.ingestEvent({
          event: {
            ...firstEvent,
            eventId: randomUUID(),
          },
        }),
      ),
    ).resolves.toEqual({ state: "event_conflict" });
    await expect(
      persistence.transaction(({ scheduler }) =>
        scheduler.ingestEvent({
          event: {
            ...eventEnvelope(claim, 2),
            type: "action.completed",
            payload: { commandIndex: 0, exitCode: 0, durationMs: 1 },
          },
        }),
      ),
    ).resolves.toEqual({ state: "invalid_evidence" });

    const [attempt] = await database
      .select({ sequence: runnerTaskAttempts.lastEventSequence })
      .from(runnerTaskAttempts)
      .where(eq(runnerTaskAttempts.id, claim.attemptId));
    expect(attempt?.sequence).toBe(1);
  });

  it("redacts, accounts, and replays bounded logs without changing lifecycle order", async () => {
    const claim = await claimForEvents(18, { logBytes: 60 });
    await expect(
      persistence.transaction(({ scheduler }) =>
        scheduler.ingestEvent({
          event: {
            ...eventEnvelope(claim, 1),
            type: "workspace.prepared",
            payload: {
              sourceDigest:
                "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              imageDigest:
                "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            },
          },
        }),
      ),
    ).resolves.toEqual({ state: "invalid_evidence" });

    await persistence.transaction(({ scheduler }) =>
      scheduler.ingestEvent({
        event: {
          ...eventEnvelope(claim, 1),
          type: "workspace.prepared",
          payload: {
            sourceDigest:
              "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            imageDigest:
              "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          },
        },
      }),
    );
    const rawLog =
      "Authorization: Bearer abcdefghijklmnop\n<script>alert(1)</script>";
    const logEvent = {
      ...eventEnvelope(claim, 2),
      type: "log.appended" as const,
      payload: {
        stream: "stdout" as const,
        text: rawLog,
        utf8Bytes: new TextEncoder().encode(rawLog).byteLength,
        redacted: false,
      },
    };
    const accepted = await persistence.transaction(({ scheduler }) =>
      scheduler.ingestEvent({ event: logEvent }),
    );
    expect(accepted).toMatchObject({
      state: "accepted",
      acknowledgement: { acknowledgedSequence: 2 },
    });
    await expect(
      persistence.transaction(({ scheduler }) =>
        scheduler.ingestEvent({ event: logEvent }),
      ),
    ).resolves.toMatchObject({ state: "replay" });

    await expect(
      persistence.transaction(({ scheduler }) =>
        scheduler.ingestEvent({
          event: {
            ...eventEnvelope(claim, 3),
            type: "action.started",
            payload: { commandIndex: 0 },
          },
        }),
      ),
    ).resolves.toMatchObject({ state: "accepted" });

    const attemptedText = "x".repeat(32);
    await expect(
      persistence.transaction(({ scheduler }) =>
        scheduler.ingestEvent({
          event: {
            ...eventEnvelope(claim, 4),
            type: "log.appended",
            payload: {
              stream: "stderr",
              text: attemptedText,
              utf8Bytes: attemptedText.length,
              redacted: true,
            },
          },
        }),
      ),
    ).resolves.toEqual({
      state: "budget_exhausted",
      dimension: "log_bytes",
      limitBytes: 60,
      acceptedBytes: 58,
      attemptedBytes: 32,
    });

    const [attempt] = await database
      .select({
        sequence: runnerTaskAttempts.lastEventSequence,
        acceptedLogBytes: runnerTaskAttempts.acceptedLogBytes,
      })
      .from(runnerTaskAttempts)
      .where(eq(runnerTaskAttempts.id, claim.attemptId));
    expect(attempt).toEqual({ sequence: 3, acceptedLogBytes: 58 });
    const [storedLog] = await database
      .select({ payload: runnerTaskEvents.payload })
      .from(runnerTaskEvents)
      .where(eq(runnerTaskEvents.id, logEvent.eventId));
    expect(storedLog?.payload).toEqual({
      stream: "stdout",
      text: "Authorization: Bearer [REDACTED]\n<script>alert(1)</script>",
      utf8Bytes: 58,
      redacted: true,
    });
  });

  it("commits only verified artifact metadata and accounts exact replays once", async () => {
    const claim = await claimForEvents(21, { artifactBytes: 8 });
    await persistence.transaction(({ scheduler }) =>
      scheduler.ingestEvent({
        event: {
          ...eventEnvelope(claim, 1),
          type: "workspace.prepared",
          payload: {
            sourceDigest:
              "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            imageDigest:
              "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          },
        },
      }),
    );

    const root = await mkdtemp(join(tmpdir(), "socrates-db-artifacts-"));
    try {
      const store = new LocalContentAddressedArtifactStore(root);
      const content = new TextEncoder().encode("artifact");
      const digest = contentDigest(content);
      const verifiedArtifact = await store.put({
        content: binaryChunks(content),
        expectedDigest: digest,
        expectedSizeBytes: content.byteLength,
        maxSizeBytes: content.byteLength,
      });
      const artifactEvent = {
        ...eventEnvelope(claim, 2),
        type: "artifact.produced" as const,
        payload: {
          artifactId: randomUUID(),
          digest,
          sizeBytes: content.byteLength,
          mediaType: "application/octet-stream",
          role: "diagnostic" as const,
        },
      };

      await expect(
        persistence.transaction(({ scheduler }) =>
          scheduler.ingestEvent({ event: artifactEvent }),
        ),
      ).resolves.toEqual({ state: "invalid_evidence" });
      await expect(
        persistence.transaction(({ scheduler }) =>
          scheduler.ingestEvent({ event: artifactEvent, verifiedArtifact }),
        ),
      ).resolves.toMatchObject({ state: "accepted" });
      await expect(
        persistence.transaction(({ scheduler }) =>
          scheduler.ingestEvent({ event: artifactEvent }),
        ),
      ).resolves.toMatchObject({ state: "replay" });

      const overflowContent = new TextEncoder().encode("x");
      const overflowDigest = contentDigest(overflowContent);
      const overflowVerification = await store.put({
        content: binaryChunks(overflowContent),
        expectedDigest: overflowDigest,
        expectedSizeBytes: 1,
        maxSizeBytes: 1,
      });
      await expect(
        persistence.transaction(({ scheduler }) =>
          scheduler.ingestEvent({
            event: {
              ...eventEnvelope(claim, 3),
              type: "artifact.produced",
              payload: {
                artifactId: randomUUID(),
                digest: overflowDigest,
                sizeBytes: 1,
                mediaType: "text/plain",
                role: "diagnostic",
              },
            },
            verifiedArtifact: overflowVerification,
          }),
        ),
      ).resolves.toEqual({
        state: "budget_exhausted",
        dimension: "artifact_bytes",
        limitBytes: 8,
        acceptedBytes: 8,
        attemptedBytes: 1,
      });

      const [attempt] = await database
        .select({
          sequence: runnerTaskAttempts.lastEventSequence,
          acceptedArtifactBytes: runnerTaskAttempts.acceptedArtifactBytes,
        })
        .from(runnerTaskAttempts)
        .where(eq(runnerTaskAttempts.id, claim.attemptId));
      expect(attempt).toEqual({
        sequence: 2,
        acceptedArtifactBytes: 8,
      });
      await expect(
        database
          .select()
          .from(artifactObjects)
          .where(eq(artifactObjects.digest, digest)),
      ).resolves.toHaveLength(1);
      await expect(
        database
          .select()
          .from(runnerTaskArtifacts)
          .where(eq(runnerTaskArtifacts.id, artifactEvent.payload.artifactId)),
      ).resolves.toHaveLength(1);
      await expect(
        database
          .select()
          .from(artifactObjects)
          .where(eq(artifactObjects.digest, overflowDigest)),
      ).resolves.toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects new evidence after the database lease expires", async () => {
    const claim = await claimForEvents(19);
    await database
      .update(runnerTaskAttempts)
      .set({ leaseExpiresAt: new Date(0) })
      .where(eq(runnerTaskAttempts.id, claim.attemptId));

    await expect(
      persistence.transaction(({ scheduler }) =>
        scheduler.ingestEvent({
          event: {
            ...eventEnvelope(claim, 1),
            type: "task.failed",
            payload: {
              classification: "infrastructure",
              message: "lease expired",
            },
          },
        }),
      ),
    ).resolves.toEqual({ state: "stale" });
    await persistence.transaction(({ scheduler }) =>
      scheduler.reconcileExpiredTasks({ limit: 100 }),
    );
  });

  it("commits cancellation evidence and terminal state atomically", async () => {
    const claim = await claimForEvents(20);
    await persistence.transaction(({ scheduler }) =>
      scheduler.requestCancellation({
        requestId: randomUUID(),
        workspaceId,
        taskId: claim.taskId,
        gracePeriodMs: 5_000,
        reason: "operator",
      }),
    );
    const cancelled = {
      ...eventEnvelope(claim, 1),
      type: "task.cancelled" as const,
      payload: { forced: true, durationMs: 200 },
    };

    await expect(
      persistence.transaction(({ scheduler }) =>
        scheduler.ingestEvent({ event: cancelled }),
      ),
    ).resolves.toMatchObject({
      state: "accepted",
      acknowledgement: { acknowledgedSequence: 1 },
    });
    await expect(
      persistence.transaction(({ scheduler }) =>
        scheduler.ingestEvent({ event: cancelled }),
      ),
    ).resolves.toMatchObject({
      state: "replay",
      acknowledgement: { acknowledgedSequence: 1 },
    });

    const [attempt] = await database
      .select({
        status: runnerTaskAttempts.status,
        sequence: runnerTaskAttempts.lastEventSequence,
      })
      .from(runnerTaskAttempts)
      .where(eq(runnerTaskAttempts.id, claim.attemptId));
    const [storedTask] = await database
      .select({ status: runnerTasks.status })
      .from(runnerTasks)
      .where(eq(runnerTasks.id, claim.taskId));
    expect(attempt).toEqual({ status: "cancelled", sequence: 1 });
    expect(storedTask?.status).toBe("cancelled");
  });

  it("catalogs immutable sources and authorizes only the live owning attempt", async () => {
    const taskId = randomUUID();
    const attemptId = randomUUID();
    const sourceTask = task(taskId, experimentIds[21]!);
    const sourcePayload = experimentTaskV2Schema.parse(sourceTask.payload);
    const root = await mkdtemp(join(tmpdir(), "socrates-db-source-"));

    try {
      const store = new LocalContentAddressedArtifactStore(root);
      const content = new TextEncoder().encode("immutable source snapshot");
      const digest = contentDigest(content);
      const artifact = await store.put({
        content: binaryChunks(content),
        expectedDigest: digest,
        expectedSizeBytes: content.byteLength,
        maxSizeBytes: content.byteLength,
      });
      sourcePayload.source.digest = digest;
      sourceTask.payload = sourcePayload;

      await persistence.transaction(({ scheduler }) =>
        scheduler.createTask(sourceTask),
      );
      const claim = await persistence.transaction(({ scheduler }) =>
        scheduler.claimTask({
          runnerId,
          taskId,
          attemptId,
          leaseDurationMs: 120_000,
        }),
      );
      expect(claim.state).toBe("claimed");
      if (claim.state !== "claimed") return;

      const catalogInput = {
        snapshotId: sourcePayload.source.snapshotId,
        artifact,
        mediaType: "application/vnd.socrates.source-snapshot.v1+tar",
      };
      await expect(
        persistence.transaction(({ scheduler }) =>
          scheduler.catalogSourceSnapshot(catalogInput),
        ),
      ).resolves.toEqual({ state: "created" });
      await expect(
        persistence.transaction(({ scheduler }) =>
          scheduler.catalogSourceSnapshot(catalogInput),
        ),
      ).resolves.toEqual({ state: "replay" });

      const authorization = {
        runnerId,
        taskId,
        attemptId,
        fence: claim.claim.fence,
        snapshotId: sourcePayload.source.snapshotId,
        digest,
      };
      await expect(
        persistence.transaction(({ scheduler }) =>
          scheduler.authorizeSourceSnapshot(authorization),
        ),
      ).resolves.toEqual({
        state: "authorized",
        source: {
          snapshotId: sourcePayload.source.snapshotId,
          digest,
          sizeBytes: content.byteLength,
          mediaType: "application/vnd.socrates.source-snapshot.v1+tar",
        },
      });
      await expect(
        persistence.transaction(({ scheduler }) =>
          scheduler.authorizeSourceSnapshot({
            ...authorization,
            runnerId: secondRunnerId,
          }),
        ),
      ).resolves.toEqual({ state: "stale" });
      await expect(
        persistence.transaction(({ scheduler }) =>
          scheduler.authorizeSourceSnapshot({
            ...authorization,
            digest:
              "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
          }),
        ),
      ).resolves.toEqual({ state: "source_mismatch" });

      await expect(
        database
          .select()
          .from(sourceSnapshots)
          .where(eq(sourceSnapshots.id, sourcePayload.source.snapshotId)),
      ).resolves.toHaveLength(1);
      await database
        .update(runnerTaskAttempts)
        .set({ leaseExpiresAt: new Date(0) })
        .where(eq(runnerTaskAttempts.id, attemptId));
      await expect(
        persistence.transaction(({ scheduler }) =>
          scheduler.authorizeSourceSnapshot(authorization),
        ),
      ).resolves.toEqual({ state: "stale" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
