import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  experimentTaskV2Schema,
  runnerExecutionV1Schema,
} from "@socrates/contracts";
import {
  createPersistence,
  seedEmptyDevelopmentWorkspace,
} from "@socrates/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ExperimentTaskV2, RunnerExecutionV1 } from "@socrates/contracts";
import type {
  ClaimRunnerTaskResult,
  Persistence,
  RunnerTaskWrite,
} from "@socrates/database";
import { DeterministicFakeRunner } from "./deterministic-fake-runner";

const connectionString = process.env["DATABASE_URL"];
const integration = describe.skipIf(!connectionString);

integration("deterministic fake runner vertical slice", () => {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const runId = randomUUID();
  const metricDefinitionId = randomUUID();
  const baseExperimentId = randomUUID();
  const runnerId = randomUUID();
  const cancellationExperimentId = randomUUID();
  const gapExperimentId = randomUUID();
  let persistence: Persistence;
  let fixture: ExperimentTaskV2;

  beforeAll(async () => {
    if (!connectionString) return;
    await seedEmptyDevelopmentWorkspace(connectionString, {
      id: workspaceId,
      name: "Deterministic Fake Runner Integration",
    });
    persistence = createPersistence({ connectionString });
    fixture = experimentTaskV2Schema.parse(
      JSON.parse(
        await readFile(
          new URL(
            "../../../../packages/contracts/fixtures/runner/task-v2.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ),
    );

    await persistence.transaction(async ({ commands, scheduler }) => {
      await expect(
        commands.createProject({
          id: projectId,
          workspaceId,
          name: "Deterministic Fake Runner",
          slug: `deterministic-fake-runner-${projectId}`,
          objective: "Verify deterministic task evidence independently.",
          sourceType: null,
          sourceReference: null,
          metric: {
            id: metricDefinitionId,
            projectId,
            version: 1,
            name: "duration",
            unit: "ms",
            direction: "minimize",
            minimumImprovement: "1",
            noiseTolerance: "0",
            guardrails: [],
          },
        }),
      ).resolves.toEqual({ state: "created" });
      await expect(
        commands.createRun(
          {
            id: runId,
            projectId,
            metricDefinitionId,
            title: "Deterministic execution",
            objective: "Preserve ordered task evidence.",
            budget: {
              maximumExperiments: 3,
              maximumDurationMs: 300_000,
              maximumCostMinor: 0,
            },
          },
          0,
        ),
      ).resolves.toEqual({ sequence: 1 });
      await scheduler.registerRunner({
        id: runnerId,
        workspaceId,
        kind: "local",
        softwareVersion: "fake-1",
        taskProtocolVersions: ["2"],
        eventProtocolVersions: ["2"],
        sandboxBackend: "oci",
        capabilities: fixture.environment.requiredCapabilities,
        maximumConcurrentTasks: 3,
      });
      await expect(
        commands.createExperiment(
          {
            id: baseExperimentId,
            runId,
            parentExperimentId: null,
            hypothesis: "Deterministic completion remains replayable.",
            action: "Complete deterministic fake work.",
            estimatedDurationMs: 1_000,
            estimatedCostMinor: 0,
          },
          0,
        ),
      ).resolves.toEqual({ sequence: 1 });
      await expect(
        commands.createExperiment(
          {
            id: cancellationExperimentId,
            runId,
            parentExperimentId: baseExperimentId,
            hypothesis: "Cancellation remains durable.",
            action: "Cancel deterministic fake work.",
            estimatedDurationMs: 1_000,
            estimatedCostMinor: 0,
          },
          1,
        ),
      ).resolves.toEqual({ sequence: 2 });
      await expect(
        commands.createExperiment(
          {
            id: gapExperimentId,
            runId,
            parentExperimentId: cancellationExperimentId,
            hypothesis: "Sequence gaps recover without evidence loss.",
            action: "Replay the deterministic spool in order.",
            estimatedDurationMs: 1_000,
            estimatedCostMinor: 0,
          },
          2,
        ),
      ).resolves.toEqual({ sequence: 3 });
    });
  });

  afterAll(async () => {
    await persistence?.close();
  });

  const claimExecution = async (
    experimentId: string,
  ): Promise<RunnerExecutionV1> => {
    const taskId = randomUUID();
    const attemptId = randomUUID();
    const payload = experimentTaskV2Schema.parse({
      ...fixture,
      taskId,
      runId,
      experimentId,
      measurement: {
        ...fixture.measurement,
        metricDefinitionId,
      },
    });
    const write: RunnerTaskWrite = {
      id: taskId,
      workspaceId,
      projectId,
      runId,
      experimentId,
      expectedExperimentVersion: 0,
      protocolVersion: "2",
      payload,
    };
    await persistence.transaction(({ scheduler }) =>
      scheduler.createTask(write),
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
      throw new Error(`Fake runner claim failed: ${result.state}.`);
    }
    const claim = (
      result as Extract<ClaimRunnerTaskResult, { state: "claimed" }>
    ).claim;
    return runnerExecutionV1Schema.parse({
      version: "1",
      lease: {
        version: "1",
        runnerId,
        taskId,
        attemptId,
        fence: claim.fence,
        leasedUntil: claim.leaseExpiresAt.toISOString(),
      },
      task: claim.payload,
    });
  };

  it("completes and replays a claim-to-terminal lifecycle", async () => {
    const execution = await claimExecution(baseExperimentId);
    const runner = new DeterministicFakeRunner({ measurementAmount: "2.1" });

    for await (const event of runner.execute(execution)) {
      await expect(
        persistence.transaction(({ scheduler }) =>
          scheduler.ingestEvent({ event }),
        ),
      ).resolves.toMatchObject({ state: "accepted" });
    }

    const restarted = new DeterministicFakeRunner({
      measurementAmount: "2.1",
    });
    for await (const event of restarted.execute(execution)) {
      await expect(
        persistence.transaction(({ scheduler }) =>
          scheduler.ingestEvent({ event }),
        ),
      ).resolves.toMatchObject({ state: "replay" });
    }
    await expect(
      persistence.transaction(({ scheduler }) =>
        scheduler.completeTask({
          runnerId,
          taskId: execution.lease.taskId,
          attemptId: execution.lease.attemptId,
          fence: execution.lease.fence,
          outcome: { status: "succeeded" },
        }),
      ),
    ).resolves.toEqual({ state: "stale" });
  });

  it("recovers an out-of-order delivery from the deterministic spool", async () => {
    const execution = await claimExecution(gapExperimentId);
    const runner = new DeterministicFakeRunner({ measurementAmount: "2" });
    const events = await Array.fromAsync(runner.execute(execution));

    await expect(
      persistence.transaction(({ scheduler }) =>
        scheduler.ingestEvent({ event: events[1]! }),
      ),
    ).resolves.toEqual({ state: "gap", expectedSequence: 1 });
    for (const event of events) {
      await expect(
        persistence.transaction(({ scheduler }) =>
          scheduler.ingestEvent({ event }),
        ),
      ).resolves.toMatchObject({ state: "accepted" });
    }
  });

  it("survives cancellation and restart without duplicating evidence", async () => {
    const execution = await claimExecution(cancellationExperimentId);
    const runner = new DeterministicFakeRunner({ measurementAmount: "2.2" });
    const iterator = runner.execute(execution)[Symbol.asyncIterator]();
    const prepared = await iterator.next();
    if (prepared.done) throw new Error("Fake runner ended before preparation.");
    await persistence.transaction(({ scheduler }) =>
      scheduler.ingestEvent({ event: prepared.value }),
    );
    await persistence.transaction(({ scheduler }) =>
      scheduler.requestCancellation({
        requestId: randomUUID(),
        workspaceId,
        taskId: execution.lease.taskId,
        gracePeriodMs: 5_000,
        reason: "operator",
      }),
    );
    const cancellation = {
      version: "1" as const,
      runnerId,
      taskId: execution.lease.taskId,
      attemptId: execution.lease.attemptId,
      fence: execution.lease.fence,
      requestedAt: "2026-07-31T00:00:01.000Z",
      gracePeriodMs: 100,
      reason: "operator" as const,
    };
    await runner.cancel(cancellation);
    const terminal = await iterator.next();
    if (terminal.done) throw new Error("Fake runner omitted cancellation.");
    await expect(
      persistence.transaction(({ scheduler }) =>
        scheduler.ingestEvent({ event: terminal.value }),
      ),
    ).resolves.toMatchObject({ state: "accepted" });

    const restarted = new DeterministicFakeRunner({
      measurementAmount: "2.2",
    });
    const replay = restarted.execute(execution)[Symbol.asyncIterator]();
    const replayedPrepared = await replay.next();
    if (replayedPrepared.done) throw new Error("Restart omitted preparation.");
    await expect(
      persistence.transaction(({ scheduler }) =>
        scheduler.ingestEvent({ event: replayedPrepared.value }),
      ),
    ).resolves.toMatchObject({ state: "replay" });
    await restarted.cancel(cancellation);
    const replayedTerminal = await replay.next();
    if (replayedTerminal.done) throw new Error("Restart omitted cancellation.");
    await expect(
      persistence.transaction(({ scheduler }) =>
        scheduler.ingestEvent({ event: replayedTerminal.value }),
      ),
    ).resolves.toMatchObject({ state: "replay" });
  });
});
