import { readFile } from "node:fs/promises";

import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  constraintDefinitions,
  decisions,
  experiments,
  idempotencyKeys,
  learningEvidence,
  learnings,
  metricDefinitions,
  observations,
  projects,
  runBudgets,
  runEvents,
  runs,
  schemaMetadata,
  workspaces,
} from "./schema/index";

const tables = [
  workspaces,
  projects,
  metricDefinitions,
  constraintDefinitions,
  runs,
  runBudgets,
  experiments,
  observations,
  decisions,
  learnings,
  learningEvidence,
  runEvents,
  idempotencyKeys,
  schemaMetadata,
];

describe("Phase 1 migration", () => {
  it("exports every normalized ledger table exactly once", () => {
    const names = tables.map((table) => getTableConfig(table).name);

    expect(new Set(names).size).toBe(14);
    expect(names).toEqual([
      "workspaces",
      "projects",
      "metric_definitions",
      "constraint_definitions",
      "runs",
      "run_budgets",
      "experiments",
      "observations",
      "decisions",
      "learnings",
      "learning_evidence",
      "run_events",
      "idempotency_keys",
      "socrates_schema_metadata",
    ]);
  });

  it("contains executable literal checks instead of bound placeholders", async () => {
    const migration = await readFile(
      new URL("../drizzle/0000_phase_1_ledger.sql", import.meta.url),
      "utf8",
    );

    expect(migration).not.toMatch(/\$\d+/);
    expect(migration).toContain(
      `"observations_amount_canonical" CHECK ("observations"."amount" ~ '^-?`,
    );
    expect(migration).toContain(
      `CONSTRAINT "experiments_run_id_unique" UNIQUE("run_id","id")`,
    );
    expect(migration).toContain(
      `CONSTRAINT "idempotency_keys_response_complete" CHECK`,
    );
    expect(migration.match(/CREATE TABLE /g)).toHaveLength(13);
  });

  it("pins schema compatibility and cursor-order indexes", async () => {
    const [migration, cleanup] = await Promise.all([
      readFile(
        new URL(
          "../drizzle/0003_phase_1_acceptance_hardening.sql",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(
        new URL(
          "../drizzle/0004_remove_redundant_evidence_indexes.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    ]);

    expect(migration).toContain(
      `INSERT INTO "socrates_schema_metadata" ("id", "version") VALUES (1, 1)`,
    );
    for (const indexName of [
      "projects_workspace_created_id_idx",
      "runs_project_created_id_idx",
      "experiments_run_created_id_idx",
      "learnings_project_created_id_idx",
      "learnings_created_id_idx",
      "observations_experiment_recorded_id_idx",
      "decisions_experiment_created_id_idx",
    ]) {
      expect(migration).toContain(`CREATE INDEX "${indexName}"`);
    }
    expect(cleanup).toContain(`DROP INDEX "observations_experiment_idx"`);
    expect(cleanup).toContain(`DROP INDEX "decisions_experiment_created_idx"`);
  });
});
