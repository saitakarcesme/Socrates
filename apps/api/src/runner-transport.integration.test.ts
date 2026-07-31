import {
  apiErrorSchema,
  experimentMutationResponseSchema,
  projectMutationResponseSchema,
  runnerEventSubmitResponseV1Schema,
  runnerTaskDeliveryAcquireResponseV1Schema,
  runnerTaskClaimResponseV1Schema,
  runnerTaskHeartbeatResponseV1Schema,
  runMutationResponseSchema,
} from "@socrates/contracts";
import {
  createPersistence,
  seedEmptyDevelopmentWorkspace,
  type Persistence,
} from "@socrates/database";
import {
  generateRunnerCredential,
  OpaqueRunnerAuthenticator,
} from "@socrates/runner-auth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "./app";

const connectionString = process.env["DATABASE_URL"];
const integration = describe.skipIf(!connectionString);

integration("authenticated runner transport with PostgreSQL", () => {
  const workspaceId = crypto.randomUUID();
  const runnerId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  const suffix = crypto.randomUUID().slice(0, 12);
  const capabilities = [
    {
      kind: "sandbox.oci",
      platform: "linux",
      architecture: "amd64",
    },
    { kind: "action.command", shell: false },
    { kind: "network.egress", mode: "disabled" },
  ] as const;

  let persistence: Persistence;
  let app: ReturnType<typeof createApp>;
  let credential: string;
  let runId: string;
  let experimentId: string;
  let metricDefinitionId: string;
  let fence: number;

  const command = (path: string, key: string, body: Record<string, unknown>) =>
    app.request(`/v1${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": `${suffix}:${key}`,
      },
      body: JSON.stringify(body),
    });

  const runnerCommand = (path: string, body: Record<string, unknown>) =>
    app.request(`/v1/runner${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    if (!connectionString) return;
    await seedEmptyDevelopmentWorkspace(connectionString, {
      id: workspaceId,
      name: `Runner Transport ${suffix}`,
    });
    persistence = createPersistence({ connectionString });
    app = createApp({
      manualResearchEnabled: true,
      persistence,
      workspaceId,
    });

    const project = projectMutationResponseSchema.parse(
      await (
        await command("/projects", "project", {
          name: `Runner Project ${suffix}`,
          objective: "Verify authenticated runner transport.",
          metric: {
            name: "duration",
            unit: "ms",
            direction: "minimize",
            minimumImprovement: "1",
            noiseTolerance: "0",
            guardrails: [],
          },
        })
      ).json(),
    );
    metricDefinitionId = project.data.currentMetricDefinitionId;
    const run = runMutationResponseSchema.parse(
      await (
        await command(`/projects/${project.data.projectId}/runs`, "run", {
          expectedProjectVersion: 0,
          title: "Authenticated execution",
          objective: "Prove the runner transport boundary.",
          metricDefinitionId,
          budget: {
            maximumExperiments: 1,
            maximumDurationMs: 60_000,
            maximumCostMinor: 0,
          },
        })
      ).json(),
    );
    runId = run.data.runId;
    await command(`/runs/${runId}/baseline`, "baseline", {
      expectedVersion: 0,
      value: { amount: "10", unit: "ms" },
      sampleCount: 1,
    });
    await command(`/runs/${runId}/start`, "start", { expectedVersion: 1 });
    const experiment = experimentMutationResponseSchema.parse(
      await (
        await command(`/runs/${runId}/experiments`, "experiment", {
          expectedRunVersion: 2,
          hypothesis: "An authenticated runner preserves fenced evidence.",
          action: "Execute the immutable test action.",
          estimatedDurationMs: 1_000,
          estimatedCostMinor: 0,
        })
      ).json(),
    );
    experimentId = experiment.data.experimentId;

    await persistence.transaction(async ({ scheduler }) => {
      await scheduler.registerRunner({
        id: runnerId,
        workspaceId,
        kind: "local",
        softwareVersion: "0.1.0",
        taskProtocolVersions: ["2"],
        eventProtocolVersions: ["2"],
        sandboxBackend: "oci",
        capabilities,
        maximumConcurrentTasks: 1,
      });
      const created = await scheduler.createTask({
        id: taskId,
        workspaceId,
        projectId: project.data.projectId,
        runId,
        experimentId,
        expectedExperimentVersion: 0,
        protocolVersion: "2",
        payload: {
          version: "2",
          taskId,
          runId,
          experimentId,
          source: {
            snapshotId: crypto.randomUUID(),
            digest: `sha256:${"a".repeat(64)}`,
          },
          hypothesis: "An authenticated runner preserves fenced evidence.",
          action: {
            kind: "command-sequence",
            revision: `sha256:${"b".repeat(64)}`,
            steps: [
              {
                executable: "/usr/bin/node",
                arguments: ["experiment.mjs"],
                workingDirectory: "/workspace",
                timeoutMs: 1_000,
              },
            ],
            retrySafe: true,
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
              timeoutMs: 1_000,
            },
            result: {
              kind: "json-stdout",
              schema: "metric-value.v1",
              maximumBytes: 4_096,
            },
          },
          constraints: [],
          environment: {
            imageDigest: `sha256:${"c".repeat(64)}`,
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
      expect(created).toEqual({ state: "created" });
    });

    const generated = generateRunnerCredential();
    const provisioned = await persistence.runnerCredentials.provision({
      tokenId: generated.tokenId,
      runnerId,
      secretDigest: generated.secretDigest,
      label: "API integration",
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(provisioned).toEqual({ state: "created" });
    credential = generated.credential;
    app = createApp({
      persistence,
      runnerAuthenticator: new OpaqueRunnerAuthenticator(
        persistence.runnerCredentials,
      ),
      workspaceId,
    });
  });

  afterAll(async () => {
    await persistence?.close();
  });

  it("binds claim, cancellation heartbeat, terminal acknowledgement, and replay", async () => {
    const unauthorized = await app.request(
      "/v1/runner/task-deliveries/acquire",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: "1" }),
      },
    );
    expect(unauthorized.status).toBe(401);
    expect(apiErrorSchema.parse(await unauthorized.json()).error.code).toBe(
      "unauthorized",
    );

    const acquired = await runnerCommand("/task-deliveries/acquire", {
      version: "1",
    });
    expect(acquired.status).toBe(200);
    const delivery = runnerTaskDeliveryAcquireResponseV1Schema.parse(
      await acquired.json(),
    ).delivery;
    expect(delivery.taskId).toBe(taskId);

    const claimResponse = await runnerCommand(
      `/task-deliveries/${delivery.deliveryId}/claims`,
      {
        version: "1",
        taskId,
        attemptId,
        leaseDurationMs: 30_000,
      },
    );
    expect(claimResponse.status).toBe(200);
    const claim = runnerTaskClaimResponseV1Schema.parse(
      await claimResponse.json(),
    );
    fence = claim.execution.lease.fence;
    expect(claim.execution).toMatchObject({
      lease: { runnerId, taskId, attemptId },
      task: { taskId, runId, experimentId },
    });

    const continuing = runnerTaskHeartbeatResponseV1Schema.parse(
      await (
        await runnerCommand(
          `/tasks/${taskId}/attempts/${attemptId}/heartbeat`,
          { version: "1", fence, leaseDurationMs: 30_000 },
        )
      ).json(),
    );
    expect(continuing.directive).toBe("continue");

    await persistence.transaction(({ scheduler }) =>
      scheduler.requestCancellation({
        requestId: crypto.randomUUID(),
        workspaceId,
        taskId,
        gracePeriodMs: 2_500,
        reason: "operator",
      }),
    );
    const cancelling = runnerTaskHeartbeatResponseV1Schema.parse(
      await (
        await runnerCommand(
          `/tasks/${taskId}/attempts/${attemptId}/heartbeat`,
          { version: "1", fence, leaseDurationMs: 30_000 },
        )
      ).json(),
    );
    expect(cancelling.directive).toBe("cancel");
    if (cancelling.directive === "cancel") {
      expect(cancelling.cancellation).toMatchObject({
        gracePeriodMs: 2_500,
        reason: "operator",
      });
    }

    const eventId = crypto.randomUUID();
    const terminalEvent = {
      version: "2",
      eventId,
      runnerId,
      taskId,
      attemptId,
      fence,
      sequence: 1,
      occurredAt: "2026-07-31T12:00:00.000Z",
      type: "task.cancelled",
      payload: { forced: true, durationMs: 10 },
    } as const;
    const accepted = runnerEventSubmitResponseV1Schema.parse(
      await (
        await runnerCommand("/events", {
          version: "1",
          event: terminalEvent,
        })
      ).json(),
    );
    expect(accepted).toMatchObject({
      replay: false,
      acknowledgement: {
        eventId,
        attemptId,
        acknowledgedSequence: 1,
        expectedSequence: 2,
      },
    });

    const replay = runnerEventSubmitResponseV1Schema.parse(
      await (
        await runnerCommand("/events", {
          version: "1",
          event: terminalEvent,
        })
      ).json(),
    );
    expect(replay).toEqual({ ...accepted, replay: true });
  });
});
