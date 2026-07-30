import {
  apiErrorSchema,
  experimentListResponseSchema,
  experimentResponseSchema,
  learningListResponseSchema,
  projectListResponseSchema,
  projectResponseSchema,
  runEventListResponseSchema,
  runListResponseSchema,
  runResponseSchema,
} from "@socrates/contracts";
import {
  createPersistence,
  developmentSeedIds,
  seedDevelopmentData,
  type Persistence,
} from "@socrates/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "./app";

const connectionString = process.env["DATABASE_URL"];
const integration = describe.skipIf(!connectionString);

integration("read API with PostgreSQL", () => {
  let persistence: Persistence;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    if (!connectionString) {
      return;
    }

    await seedDevelopmentData(connectionString);
    persistence = createPersistence({ connectionString });
    app = createApp({
      persistence,
      workspaceId: developmentSeedIds.workspace,
    });
  });

  afterAll(async () => {
    await persistence?.close();
  });

  it("paginates projects with an opaque stable cursor", async () => {
    const firstResponse = await app.request("/v1/projects?limit=1");
    const first = projectListResponseSchema.parse(await firstResponse.json());

    expect(firstResponse.status).toBe(200);
    expect(first.data.map((project) => project.slug)).toEqual(["atlas-web"]);
    expect(first.page.nextCursor).toEqual(expect.any(String));

    const secondResponse = await app.request(
      `/v1/projects?limit=1&cursor=${first.page.nextCursor}`,
    );
    const second = projectListResponseSchema.parse(await secondResponse.json());

    expect(second.data.map((project) => project.slug)).toEqual([
      "meridian-eval",
    ]);
    expect(second.page.nextCursor).toBeNull();
  });

  it("reads a project with its current metric protocol", async () => {
    const response = await app.request(
      `/v1/projects/${developmentSeedIds.atlasProject}`,
    );
    const body = projectResponseSchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(body.data.currentMetric).toMatchObject({
      id: developmentSeedIds.atlasMetric,
      direction: "minimize",
      minimumImprovement: "0.05",
      noiseTolerance: "0.01",
      guardrails: [
        {
          id: developmentSeedIds.atlasGuardrail,
          operator: "less_than_or_equal",
          threshold: "3",
          hard: true,
        },
      ],
    });
  });

  it("reads runs and their baseline without exposing database types", async () => {
    const listResponse = await app.request(
      `/v1/projects/${developmentSeedIds.atlasProject}/runs`,
    );
    const list = runListResponseSchema.parse(await listResponse.json());
    const response = await app.request(
      `/v1/runs/${developmentSeedIds.atlasRun}`,
    );
    const body = runResponseSchema.parse(await response.json());

    expect(list.data).toHaveLength(1);
    expect(body.data).toMatchObject({
      id: developmentSeedIds.atlasRun,
      baseline: { amount: "2.4", unit: "s" },
      budget: {
        maximumExperiments: 10,
        maximumDurationMs: 3_600_000,
        maximumCostMinor: 2_000,
      },
    });
  });

  it("reads the experiment timeline and individual experiment", async () => {
    const listResponse = await app.request(
      `/v1/runs/${developmentSeedIds.atlasRun}/experiments`,
    );
    const list = experimentListResponseSchema.parse(await listResponse.json());
    const response = await app.request(
      `/v1/experiments/${developmentSeedIds.atlasExperiment}`,
    );
    const body = experimentResponseSchema.parse(await response.json());

    expect(list.data.map((experiment) => experiment.sequence)).toEqual([2, 1]);
    expect(body.data).toMatchObject({
      sequence: 1,
      status: "kept",
      observations: [
        {
          kind: "before",
          value: { amount: "2.4", unit: "s" },
        },
        {
          kind: "after",
          value: { amount: "2.2", unit: "s" },
        },
        {
          kind: "guardrail",
          constraintDefinitionId: developmentSeedIds.atlasGuardrail,
        },
      ],
      decision: {
        automatedDecision: "kept",
        finalDecision: "kept",
        reason: "improved",
        calculatedImprovement: "0.2",
      },
    });
    expect(body.data.learnings.map(({ id }) => id)).toEqual([
      developmentSeedIds.atlasLearningTwo,
      developmentSeedIds.atlasLearning,
    ]);
    expect(list.data.find(({ sequence }) => sequence === 1)).toMatchObject({
      decision: { finalDecision: "kept" },
      observations: expect.any(Array),
      learnings: expect.any(Array),
    });
  });

  it("paginates learnings and replays events after a durable cursor", async () => {
    const learningResponse = await app.request(
      `/v1/projects/${developmentSeedIds.atlasProject}/learnings?limit=1`,
    );
    const learningPage = learningListResponseSchema.parse(
      await learningResponse.json(),
    );
    const eventResponse = await app.request(
      `/v1/runs/${developmentSeedIds.atlasRun}/events?after=1`,
    );
    const eventPage = runEventListResponseSchema.parse(
      await eventResponse.json(),
    );

    expect(learningPage.data).toHaveLength(1);
    expect(learningPage.page.nextCursor).toEqual(expect.any(String));
    expect(eventPage.data.map((event) => event.sequence)).toEqual([2]);
    expect(eventPage.page.nextCursor).toBeNull();
  });

  it("replays SSE from Last-Event-ID using durable event sequences", async () => {
    const controller = new AbortController();
    const response = await app.request(
      `/v1/runs/${developmentSeedIds.atlasRun}/events?after=2`,
      {
        headers: {
          accept: "text/event-stream",
          "last-event-id": "1",
        },
        signal: controller.signal,
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const decoder = new TextDecoder();
    let received = "";

    for (
      let attempt = 0;
      attempt < 5 && !received.includes("\n\n");
      attempt++
    ) {
      const chunk = await reader?.read();
      if (chunk?.value) received += decoder.decode(chunk.value);
    }

    expect(received).toContain("event: run-event");
    expect(received).toContain("id: 2");
    expect(received).not.toContain("id: 1");

    controller.abort();
    await reader?.cancel();
  });

  it("rejects an invalid SSE reconnect cursor before streaming", async () => {
    const response = await app.request(
      `/v1/runs/${developmentSeedIds.atlasRun}/events`,
      {
        headers: {
          accept: "text/event-stream",
          "last-event-id": "-1",
        },
      },
    );

    expect(response.status).toBe(400);
    expect(apiErrorSchema.parse(await response.json()).error.code).toBe(
      "validation_failed",
    );
  });

  it("keeps every read inside the configured workspace boundary", async () => {
    const isolated = createApp({
      reads: persistence.reads,
      workspaceId: "019c1170-8b7a-7a60-b7f8-f35c85d75999",
    });
    const listResponse = await isolated.request("/v1/projects");
    const list = projectListResponseSchema.parse(await listResponse.json());
    const resourceResponse = await isolated.request(
      `/v1/runs/${developmentSeedIds.atlasRun}`,
    );

    expect(list.data).toEqual([]);
    expect(resourceResponse.status).toBe(404);
  });
});
