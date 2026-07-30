import postgres, { type TransactionSql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const connectionString = process.env["DATABASE_URL"];
const integration = describe.skipIf(!connectionString);
const scopeId = "019c1170-8b7a-7a60-b7f8-f35c85d75000";

integration("PostgreSQL read query plans", () => {
  let client: ReturnType<typeof postgres>;

  beforeAll(() => {
    client = postgres(connectionString!, { max: 1 });
  });

  afterAll(async () => {
    await client?.end();
  });

  async function explain(
    transaction: TransactionSql,
    query: string,
  ): Promise<string> {
    const rows = await transaction.unsafe<{ "QUERY PLAN": unknown }[]>(
      `EXPLAIN (FORMAT JSON, COSTS OFF) ${query}`,
    );
    return JSON.stringify(rows[0]?.["QUERY PLAN"]);
  }

  it.each([
    [
      "projects",
      `SELECT id, created_at FROM projects
       WHERE workspace_id = '${scopeId}'
       ORDER BY created_at DESC, id DESC LIMIT 101`,
      "projects_workspace_created_id_idx",
    ],
    [
      "runs",
      `SELECT id, created_at FROM runs
       WHERE project_id = '${scopeId}'
       ORDER BY created_at DESC, id DESC LIMIT 101`,
      "runs_project_created_id_idx",
    ],
    [
      "experiments",
      `SELECT id, created_at FROM experiments
       WHERE run_id = '${scopeId}'
       ORDER BY created_at DESC, id DESC LIMIT 101`,
      "experiments_run_created_id_idx",
    ],
    [
      "project learnings",
      `SELECT id, created_at FROM learnings
       WHERE project_id = '${scopeId}'
       ORDER BY created_at DESC, id DESC LIMIT 101`,
      "learnings_project_created_id_idx",
    ],
    [
      "global learning ordering",
      `SELECT id, created_at FROM learnings
       ORDER BY created_at DESC, id DESC LIMIT 101`,
      "learnings_created_id_idx",
    ],
    [
      "experiment observations",
      `SELECT id, recorded_at FROM observations
       WHERE experiment_id = '${scopeId}'
       ORDER BY recorded_at, id`,
      "observations_experiment_recorded_id_idx",
    ],
    [
      "experiment decisions",
      `SELECT id, created_at FROM decisions
       WHERE experiment_id = '${scopeId}'
       ORDER BY created_at DESC, id DESC`,
      "decisions_experiment_created_id_idx",
    ],
    [
      "workspace runner queue",
      `SELECT id, created_at FROM runner_tasks
       WHERE workspace_id = '${scopeId}' AND status = 'queued'
       ORDER BY created_at, id LIMIT 101`,
      "runner_tasks_workspace_queue_created_id_idx",
    ],
    [
      "unpublished outbox",
      `SELECT id, available_at, created_at FROM outbox_messages
       WHERE published_at IS NULL AND available_at <= CURRENT_TIMESTAMP
       ORDER BY available_at, created_at, id LIMIT 101`,
      "outbox_messages_unpublished_available_idx",
    ],
  ])("supports ordered %s reads with %s", async (_, query, indexName) => {
    await client.begin(async (transaction) => {
      await transaction`SET LOCAL enable_seqscan = off`;
      await transaction`SET LOCAL enable_bitmapscan = off`;
      const plan = await explain(transaction, query);

      expect(plan).toContain(indexName);
      expect(plan).not.toContain('"Node Type":"Sort"');
    });
  });

  it("indexes both sides of the workspace learning projection", async () => {
    await client.begin(async (transaction) => {
      await transaction`SET LOCAL enable_seqscan = off`;
      await transaction`SET LOCAL enable_bitmapscan = off`;
      const plan = await explain(
        transaction,
        `SELECT learnings.id, learnings.created_at
         FROM learnings
         INNER JOIN projects ON projects.id = learnings.project_id
         WHERE projects.workspace_id = '${scopeId}'
         ORDER BY learnings.created_at DESC, learnings.id DESC
         LIMIT 101`,
      );

      expect(plan).toMatch(/projects_workspace_(?:created_id_idx|id_unique)/);
      expect(plan).toMatch(/learnings_(?:created_id|project_created_id)_idx/);
    });
  });
});
