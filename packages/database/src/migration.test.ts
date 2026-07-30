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
];

describe("Phase 1 migration", () => {
  it("exports every normalized ledger table exactly once", () => {
    const names = tables.map((table) => getTableConfig(table).name);

    expect(new Set(names).size).toBe(13);
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
});
