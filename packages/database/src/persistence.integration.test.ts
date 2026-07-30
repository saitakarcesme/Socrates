import { randomUUID } from "node:crypto";

import { drizzle } from "drizzle-orm/postgres-js";
import { count, eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPersistence } from "./persistence";
import type { Persistence } from "./ports";
import {
  metricDefinitions,
  projects,
  runBudgets,
  runEvents,
  runs,
  workspaces,
} from "./schema/index";

const connectionString = process.env["DATABASE_URL"];
const integration = describe.skipIf(!connectionString);

integration("PostgreSQL persistence", () => {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const metricDefinitionId = randomUUID();
  const runId = randomUUID();
  const idempotencyInput = {
    workspaceId,
    key: "project:create:atlas",
    commandName: "project.create",
    requestHash: "sha256:request-a",
  };

  let persistence: Persistence;
  let client: ReturnType<typeof postgres>;
  let database: ReturnType<typeof drizzle>;

  beforeAll(async () => {
    if (!connectionString) {
      return;
    }

    client = postgres(connectionString, { max: 1 });
    database = drizzle(client);
    persistence = createPersistence({
      connectionString,
      maximumConnections: 2,
    });

    await database.insert(workspaces).values({
      id: workspaceId,
      name: "Socrates Test",
    });
    await database.insert(projects).values({
      id: projectId,
      workspaceId,
      name: "Atlas",
      slug: "atlas",
      objective: "Improve p75 LCP.",
    });
    await database.insert(metricDefinitions).values({
      id: metricDefinitionId,
      projectId,
      version: 1,
      name: "p75 LCP",
      unit: "s",
      direction: "minimize",
      minimumImprovement: "0.05",
      noiseTolerance: "0.01",
    });
    await database.insert(runs).values({
      id: runId,
      projectId,
      metricDefinitionId,
      sequence: 1,
      title: "Initial run",
      objective: "Reduce p75 LCP.",
    });
    await database.insert(runBudgets).values({
      runId,
      maximumExperiments: 10,
      maximumDurationMs: 3_600_000,
      maximumCostMinor: 1_000,
    });
  });

  afterAll(async () => {
    await persistence?.close();
    await client?.end();
  });

  it("claims, completes, and replays an idempotent response", async () => {
    const first = await persistence.transaction(async ({ idempotency }) => {
      const claim = await idempotency.claim(idempotencyInput);
      await idempotency.complete(idempotencyInput, {
        status: 201,
        body: { projectId },
      });
      return claim;
    });
    const replay = await persistence.transaction(({ idempotency }) =>
      idempotency.claim(idempotencyInput),
    );

    expect(first).toEqual({ state: "claimed" });
    expect(replay).toEqual({
      state: "replay",
      response: {
        status: 201,
        body: { projectId },
      },
    });
  });

  it("detects reuse of a key for another request", async () => {
    const claim = await persistence.transaction(({ idempotency }) =>
      idempotency.claim({
        ...idempotencyInput,
        requestHash: "sha256:request-b",
      }),
    );

    expect(claim).toEqual({ state: "conflict" });
  });

  it("allocates run-local event sequences and rolls back atomically", async () => {
    const first = await persistence.transaction(({ runEvents }) =>
      runEvents.append({
        runId,
        type: "run.created",
        schemaVersion: "1",
        payload: { status: "draft" },
      }),
    );
    const second = await persistence.transaction(({ runEvents }) =>
      runEvents.append({
        runId,
        type: "baseline.recorded",
        schemaVersion: "1",
        payload: { amount: "2.4", unit: "s" },
      }),
    );

    await expect(
      persistence.transaction(async ({ runEvents }) => {
        await runEvents.append({
          runId,
          type: "run.started",
          schemaVersion: "1",
          payload: { status: "running" },
        });
        throw new Error("force rollback");
      }),
    ).rejects.toThrow("force rollback");

    const [persisted] = await database
      .select({ value: count() })
      .from(runEvents)
      .where(eq(runEvents.runId, runId));

    expect([first.sequence, second.sequence]).toEqual([1, 2]);
    expect(persisted?.value).toBe(2);
  });
});
