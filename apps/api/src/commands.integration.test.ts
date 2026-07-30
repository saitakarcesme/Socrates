import {
  apiErrorSchema,
  experimentMutationResponseSchema,
  learningMutationResponseSchema,
  observationMutationResponseSchema,
  projectMutationResponseSchema,
  runEventListResponseSchema,
  runMutationResponseSchema,
  runResponseSchema,
} from "@socrates/contracts";
import {
  createPersistence,
  seedEmptyDevelopmentWorkspace,
  type Persistence,
} from "@socrates/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "./app";

const connectionString = process.env["DATABASE_URL"];
const integration = describe.skipIf(!connectionString);

integration("command API with PostgreSQL", () => {
  let persistence: Persistence;
  let app: ReturnType<typeof createApp>;
  const suffix = crypto.randomUUID().slice(0, 12);
  const workspaceId = crypto.randomUUID();

  const command = (path: string, key: string, body: Record<string, unknown>) =>
    app.request(`/v1${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": `${suffix}:${key}`,
      },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    if (!connectionString) {
      return;
    }

    await seedEmptyDevelopmentWorkspace(connectionString, {
      id: workspaceId,
      name: `Command Integration ${suffix}`,
    });
    persistence = createPersistence({ connectionString });
    app = createApp({
      persistence,
      workspaceId,
    });
  });

  afterAll(async () => {
    await persistence?.close();
  });

  it("executes a measured experiment with replay, rollback, and conflicts", async () => {
    const projectCommand = {
      name: `Command Flow ${suffix}`,
      objective: "Improve LCP under a hard ceiling.",
      metric: {
        name: "p75 LCP",
        unit: "s",
        direction: "minimize",
        minimumImprovement: "0.05",
        noiseTolerance: "0.01",
        guardrails: [
          {
            name: "LCP ceiling",
            unit: "s",
            operator: "less_than_or_equal",
            threshold: "3",
            hard: true,
          },
        ],
      },
    };
    const createdProjectResponse = await command(
      "/projects",
      "project",
      projectCommand,
    );
    const createdProject = projectMutationResponseSchema.parse(
      await createdProjectResponse.json(),
    );

    expect(createdProjectResponse.status).toBe(201);
    expect(createdProject.data).toMatchObject({
      projectVersion: 0,
      guardrails: [{ name: "LCP ceiling", unit: "s" }],
    });

    const replayResponse = await command(
      "/projects",
      "project",
      projectCommand,
    );
    expect(replayResponse.status).toBe(201);
    expect(replayResponse.headers.get("Idempotency-Replayed")).toBe("true");
    await expect(replayResponse.json()).resolves.toEqual(createdProject);

    const idempotencyConflict = await command("/projects", "project", {
      ...projectCommand,
      objective: "A different request.",
    });
    expect(idempotencyConflict.status).toBe(409);
    expect(
      apiErrorSchema.parse(await idempotencyConflict.json()).error.code,
    ).toBe("idempotency_conflict");

    const metricResponse = await command(
      `/projects/${createdProject.data.projectId}/metric-definitions`,
      "metric",
      {
        expectedProjectVersion: 0,
        metric: projectCommand.metric,
      },
    );
    const activeMetric = projectMutationResponseSchema.parse(
      await metricResponse.json(),
    );
    expect(metricResponse.status).toBe(201);
    expect(activeMetric.data).toMatchObject({ projectVersion: 1 });

    const runResponse = await command(
      `/projects/${createdProject.data.projectId}/runs`,
      "run",
      {
        expectedProjectVersion: 1,
        title: "Critical rendering path",
        objective: "Reduce measured LCP.",
        metricDefinitionId: activeMetric.data.currentMetricDefinitionId,
        budget: {
          maximumExperiments: 1,
          maximumDurationMs: 60_000,
          maximumCostMinor: 100,
        },
      },
    );
    const createdRun = runMutationResponseSchema.parse(
      await runResponse.json(),
    );
    expect(runResponse.status).toBe(201);
    expect(createdRun.data).toMatchObject({ version: 0, status: "draft" });

    const revisedMetricResponse = await command(
      `/projects/${createdProject.data.projectId}/metric-definitions`,
      "metric-revision",
      {
        expectedProjectVersion: 2,
        metric: {
          ...projectCommand.metric,
          name: "Revised p75 LCP",
        },
      },
    );
    const revisedMetric = projectMutationResponseSchema.parse(
      await revisedMetricResponse.json(),
    );
    expect(revisedMetric.data).toMatchObject({ projectVersion: 3 });

    const staleRunResponse = await command(
      `/projects/${createdProject.data.projectId}/runs`,
      "stale-run",
      {
        expectedProjectVersion: 1,
        title: "Stale",
        objective: "Must not be created.",
        metricDefinitionId: activeMetric.data.currentMetricDefinitionId,
        budget: {
          maximumExperiments: 1,
          maximumDurationMs: 1,
          maximumCostMinor: 0,
        },
      },
    );
    expect(staleRunResponse.status).toBe(409);
    expect(apiErrorSchema.parse(await staleRunResponse.json()).error.code).toBe(
      "version_conflict",
    );

    const wrongBaseline = await command(
      `/runs/${createdRun.data.runId}/baseline`,
      "wrong-baseline",
      {
        expectedVersion: 0,
        value: { amount: "2400", unit: "ms" },
        sampleCount: 3,
      },
    );
    expect(wrongBaseline.status).toBe(422);
    expect(apiErrorSchema.parse(await wrongBaseline.json()).error.code).toBe(
      "protocol_mismatch",
    );

    const unchangedRunResponse = await app.request(
      `/v1/runs/${createdRun.data.runId}`,
    );
    const unchangedRun = runResponseSchema.parse(
      await unchangedRunResponse.json(),
    );
    expect(unchangedRun.data).toMatchObject({
      version: 0,
      baseline: null,
      status: "draft",
      metricDefinition: {
        id: activeMetric.data.currentMetricDefinitionId,
        version: 2,
        name: "p75 LCP",
      },
    });

    const streamController = new AbortController();
    const streamResponse = await app.request(
      `/v1/runs/${createdRun.data.runId}/events`,
      {
        headers: {
          accept: "text/event-stream",
          "last-event-id": "1",
        },
        signal: streamController.signal,
      },
    );
    const streamReader = streamResponse.body?.getReader();

    const baselineResponse = await command(
      `/runs/${createdRun.data.runId}/baseline`,
      "baseline",
      {
        expectedVersion: 0,
        value: { amount: "2.4", unit: "s" },
        sampleCount: 3,
      },
    );
    expect(
      runMutationResponseSchema.parse(await baselineResponse.json()).data,
    ).toMatchObject({ version: 1, status: "draft" });

    const decoder = new TextDecoder();
    let liveEvent = "";
    for (
      let attempt = 0;
      attempt < 5 && !liveEvent.includes("event: run-event");
      attempt++
    ) {
      const liveChunk = await streamReader?.read();
      if (liveChunk?.value) {
        liveEvent += decoder.decode(liveChunk.value);
      }
    }
    expect(liveEvent).toContain("event: run-event");
    expect(liveEvent).toContain("id: 2");
    expect(liveEvent).toContain("run.baseline_recorded");
    streamController.abort();
    await streamReader?.cancel();

    const startRunResponse = await command(
      `/runs/${createdRun.data.runId}/start`,
      "start-run",
      { expectedVersion: 1 },
    );
    expect(
      runMutationResponseSchema.parse(await startRunResponse.json()).data,
    ).toMatchObject({ version: 2, status: "running" });

    const exhaustedResponse = await command(
      `/runs/${createdRun.data.runId}/experiments`,
      "over-budget",
      {
        expectedRunVersion: 2,
        hypothesis: "An over-budget experiment.",
        action: "Spend too much.",
        estimatedDurationMs: 1_000,
        estimatedCostMinor: 101,
      },
    );
    expect(exhaustedResponse.status).toBe(409);
    expect(
      apiErrorSchema.parse(await exhaustedResponse.json()).error.code,
    ).toBe("budget_exhausted");

    const experimentResponse = await command(
      `/runs/${createdRun.data.runId}/experiments`,
      "experiment",
      {
        expectedRunVersion: 2,
        hypothesis: "Inlining critical CSS will improve LCP.",
        action: "Inline critical CSS for the landing route.",
        estimatedDurationMs: 1_000,
        estimatedCostMinor: 10,
      },
    );
    const experiment = experimentMutationResponseSchema.parse(
      await experimentResponse.json(),
    );
    expect(experiment.data).toMatchObject({
      version: 0,
      status: "proposed",
    });

    const openRunCompletion = await command(
      `/runs/${createdRun.data.runId}/complete`,
      "complete-open",
      { expectedVersion: 3 },
    );
    expect(openRunCompletion.status).toBe(409);
    expect(
      apiErrorSchema.parse(await openRunCompletion.json()).error.code,
    ).toBe("invalid_transition");

    const startExperimentResponse = await command(
      `/experiments/${experiment.data.experimentId}/start`,
      "start-experiment",
      { expectedVersion: 0 },
    );
    expect(
      experimentMutationResponseSchema.parse(
        await startExperimentResponse.json(),
      ).data,
    ).toMatchObject({ version: 1, status: "executing" });

    const beforeResponse = await command(
      `/experiments/${experiment.data.experimentId}/observations`,
      "before",
      {
        expectedVersion: 1,
        kind: "before",
        metricDefinitionId: activeMetric.data.currentMetricDefinitionId,
        value: { amount: "2.4", unit: "s" },
        sampleCount: 3,
      },
    );
    expect(
      observationMutationResponseSchema.parse(await beforeResponse.json()).data,
    ).toMatchObject({ version: 2, status: "executing" });

    const guardrailResponse = await command(
      `/experiments/${experiment.data.experimentId}/observations`,
      "guardrail",
      {
        expectedVersion: 2,
        kind: "guardrail",
        constraintDefinitionId:
          activeMetric.data.guardrails[0]?.constraintDefinitionId,
        value: { amount: "2.2", unit: "s" },
        sampleCount: 3,
      },
    );
    expect(
      observationMutationResponseSchema.parse(await guardrailResponse.json())
        .data,
    ).toMatchObject({ version: 3, status: "executing" });

    const afterResponse = await command(
      `/experiments/${experiment.data.experimentId}/observations`,
      "after",
      {
        expectedVersion: 3,
        kind: "after",
        metricDefinitionId: activeMetric.data.currentMetricDefinitionId,
        value: { amount: "2.2", unit: "s" },
        sampleCount: 3,
      },
    );
    expect(
      observationMutationResponseSchema.parse(await afterResponse.json()).data,
    ).toMatchObject({ version: 4, status: "measuring" });

    const decisionResponse = await command(
      `/experiments/${experiment.data.experimentId}/decision`,
      "decision",
      { expectedVersion: 4 },
    );
    expect(
      experimentMutationResponseSchema.parse(await decisionResponse.json())
        .data,
    ).toMatchObject({ version: 5, status: "kept" });

    const learningResponse = await command(
      `/experiments/${experiment.data.experimentId}/learnings`,
      "learning",
      {
        expectedVersion: 5,
        statement: "Inlining critical CSS improved p75 LCP by 0.2 s.",
        confidence: 0.9,
      },
    );
    expect(
      learningMutationResponseSchema.parse(await learningResponse.json()).data,
    ).toMatchObject({
      experimentId: experiment.data.experimentId,
      version: 6,
    });

    const completeResponse = await command(
      `/runs/${createdRun.data.runId}/complete`,
      "complete",
      { expectedVersion: 3 },
    );
    expect(
      runMutationResponseSchema.parse(await completeResponse.json()).data,
    ).toMatchObject({ version: 4, status: "completed" });

    const eventsResponse = await app.request(
      `/v1/runs/${createdRun.data.runId}/events?limit=100`,
    );
    const events = runEventListResponseSchema.parse(
      await eventsResponse.json(),
    );
    expect(events.data.map((event) => event.type)).toEqual([
      "run.created",
      "run.baseline_recorded",
      "run.started",
      "experiment.proposed",
      "experiment.started",
      "experiment.observation_recorded",
      "experiment.observation_recorded",
      "experiment.observation_recorded",
      "experiment.decided",
      "experiment.learning_recorded",
      "run.completed",
    ]);
    expect(events.data.map((event) => event.sequence)).toEqual(
      Array.from({ length: 11 }, (_, index) => index + 1),
    );

    const cancellableRunResponse = await command(
      `/projects/${createdProject.data.projectId}/runs`,
      "cancel-run-create",
      {
        expectedProjectVersion: 3,
        title: "Cancellation path",
        objective: "Verify controlled cancellation.",
        metricDefinitionId: revisedMetric.data.currentMetricDefinitionId,
        budget: {
          maximumExperiments: 1,
          maximumDurationMs: 1_000,
          maximumCostMinor: 0,
        },
      },
    );
    const cancellableRun = runMutationResponseSchema.parse(
      await cancellableRunResponse.json(),
    );
    await command(
      `/runs/${cancellableRun.data.runId}/baseline`,
      "cancel-baseline",
      {
        expectedVersion: 0,
        value: { amount: "2.4", unit: "s" },
        sampleCount: 1,
      },
    );
    await command(`/runs/${cancellableRun.data.runId}/start`, "cancel-start", {
      expectedVersion: 1,
    });
    const cancelledResponse = await command(
      `/runs/${cancellableRun.data.runId}/cancel`,
      "cancel",
      { expectedVersion: 2, reason: "Operator stopped the run." },
    );
    expect(
      runMutationResponseSchema.parse(await cancelledResponse.json()).data,
    ).toMatchObject({ version: 3, status: "cancelled" });
  });

  it("serializes concurrent requests with the same idempotency key", async () => {
    const body = {
      name: `Concurrent ${suffix}`,
      objective: "Create exactly one project.",
      metric: {
        name: "Score",
        unit: "points",
        direction: "maximize",
        minimumImprovement: "1",
        noiseTolerance: "0",
        guardrails: [],
      },
    };
    const responses = await Promise.all([
      command("/projects", "concurrent-project", body),
      command("/projects", "concurrent-project", body),
    ]);
    const payloads = await Promise.all(
      responses.map(async (item) =>
        projectMutationResponseSchema.parse(await item.json()),
      ),
    );

    expect(responses.map((item) => item.status)).toEqual([201, 201]);
    expect(
      responses.filter(
        (item) => item.headers.get("Idempotency-Replayed") === "true",
      ),
    ).toHaveLength(1);
    expect(payloads[0]).toEqual(payloads[1]);
  });
});
