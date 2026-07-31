import { readFile } from "node:fs/promises";

import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  artifactObjects,
  constraintDefinitions,
  decisions,
  experiments,
  idempotencyKeys,
  learningEvidence,
  learnings,
  metricDefinitions,
  observations,
  outboxMessages,
  projects,
  runBudgets,
  runEvents,
  runs,
  runnerRegistrations,
  runnerRegistrationTokens,
  runnerTaskAttempts,
  runnerTaskArtifacts,
  runnerTaskCancellations,
  runnerTaskDeliveries,
  runnerTaskEvents,
  runnerTasks,
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

describe("Phase 2 scheduler migration", () => {
  it("exports the durable scheduler tables", () => {
    expect(
      [
        runnerRegistrations,
        runnerRegistrationTokens,
        runnerTasks,
        runnerTaskAttempts,
        runnerTaskCancellations,
        runnerTaskDeliveries,
        runnerTaskEvents,
        artifactObjects,
        runnerTaskArtifacts,
        outboxMessages,
      ].map((table) => getTableConfig(table).name),
    ).toEqual([
      "runner_registrations",
      "runner_registration_tokens",
      "runner_tasks",
      "runner_task_attempts",
      "runner_task_cancellations",
      "runner_task_deliveries",
      "runner_task_events",
      "artifact_objects",
      "runner_task_artifacts",
      "outbox_messages",
    ]);
  });

  it("pins tenant relationships, fencing, outbox order, and schema version", async () => {
    const migration = await readFile(
      new URL(
        "../drizzle/0005_runner_scheduler_foundations.sql",
        import.meta.url,
      ),
      "utf8",
    );

    for (const evidence of [
      `CONSTRAINT "runner_tasks_project_same_workspace_fk"`,
      `CONSTRAINT "runner_tasks_run_same_project_fk"`,
      `CONSTRAINT "runner_tasks_experiment_same_run_fk"`,
      `CREATE UNIQUE INDEX "runner_task_attempts_task_fence_unique"`,
      `CREATE UNIQUE INDEX "runner_task_attempts_one_active_per_task"`,
      `CREATE INDEX "outbox_messages_unpublished_available_idx"`,
      `CREATE INDEX "runner_tasks_workspace_queue_created_id_idx"`,
      `UPDATE "socrates_schema_metadata" SET "version" = 2`,
    ]) {
      expect(migration).toContain(evidence);
    }
    expect(migration.indexOf(`"projects_workspace_id_unique"`)).toBeLessThan(
      migration.indexOf(`"runner_tasks_project_same_workspace_fk"`),
    );
  });

  it("adds fenced task offers before advancing compatibility", async () => {
    const migration = await readFile(
      new URL("../drizzle/0010_fenced_runner_task_offers.sql", import.meta.url),
      "utf8",
    );
    for (const evidence of [
      `CREATE TABLE "runner_task_deliveries"`,
      `CREATE UNIQUE INDEX "runner_task_deliveries_one_active_per_task"`,
      `CONSTRAINT "runner_task_deliveries_task_workspace_fk"`,
      `CONSTRAINT "runner_task_deliveries_runner_workspace_fk"`,
      `CONSTRAINT "runner_task_deliveries_attempt_identity_fk"`,
      `SET "version" = 7`,
    ]) {
      expect(migration).toContain(evidence);
    }
    expect(
      migration.indexOf(`"runner_registrations_workspace_id_unique"`),
    ).toBeLessThan(
      migration.indexOf(`"runner_task_deliveries_runner_workspace_fk"`),
    );
    expect(migration.trimEnd()).toMatch(/SET "version" = 7 WHERE "id" = 1;$/u);
  });

  it("adds append-only cancellation identity and advances compatibility", async () => {
    const migration = await readFile(
      new URL("../drizzle/0006_runner_task_cancellation.sql", import.meta.url),
      "utf8",
    );

    expect(migration).toContain(`CREATE TABLE "runner_task_cancellations"`);
    expect(migration).toContain(
      `CREATE UNIQUE INDEX "runner_task_cancellations_task_unique"`,
    );
    expect(migration).toContain(
      `CREATE INDEX "runner_task_attempts_active_lease_id_idx"`,
    );
    expect(migration).toContain(`"runner_task_cancellations_resulting_status"`);
    expect(migration).toContain(`SET "version" = 3`);
  });

  it("adds ordered fenced runner evidence before advancing compatibility", async () => {
    const migration = await readFile(
      new URL("../drizzle/0007_ordered_runner_events.sql", import.meta.url),
      "utf8",
    );

    for (const evidence of [
      `CREATE TABLE "runner_task_events"`,
      `CREATE UNIQUE INDEX "runner_task_events_attempt_sequence_unique"`,
      `CREATE UNIQUE INDEX "runner_task_attempts_identity_unique"`,
      `CONSTRAINT "runner_task_events_attempt_identity_fk"`,
      `CREATE INDEX "runner_task_events_task_received_id_idx"`,
      `SET "version" = 4`,
    ]) {
      expect(migration).toContain(evidence);
    }
    expect(
      migration.indexOf(`"runner_task_attempts_identity_unique"`),
    ).toBeLessThan(
      migration.indexOf(`"runner_task_events_attempt_identity_fk"`),
    );
  });

  it("adds bounded artifact metadata and quota counters before compatibility", async () => {
    const migration = await readFile(
      new URL("../drizzle/0008_bounded_runner_evidence.sql", import.meta.url),
      "utf8",
    );

    for (const evidence of [
      `CREATE TABLE "artifact_objects"`,
      `CREATE TABLE "runner_task_artifacts"`,
      `ADD COLUMN "accepted_log_bytes" bigint DEFAULT 0 NOT NULL`,
      `ADD COLUMN "accepted_artifact_bytes" bigint DEFAULT 0 NOT NULL`,
      `CONSTRAINT "runner_task_artifacts_attempt_identity_fk"`,
      `CONSTRAINT "runner_task_artifacts_media_type"`,
      `SET "version" = 5`,
    ]) {
      expect(migration).toContain(evidence);
    }
    expect(migration.indexOf(`CREATE TABLE "artifact_objects"`)).toBeLessThan(
      migration.indexOf(`"runner_task_artifacts_digest_artifact_objects`),
    );
  });

  it("adds revocable runner credentials before advancing compatibility", async () => {
    const migration = await readFile(
      new URL("../drizzle/0009_runner_transport_auth.sql", import.meta.url),
      "utf8",
    );

    for (const evidence of [
      `CREATE TABLE "runner_registration_tokens"`,
      `CONSTRAINT "runner_registration_tokens_secret_digest_sha256"`,
      `CREATE UNIQUE INDEX "runner_registration_tokens_secret_digest_unique"`,
      `CREATE INDEX "runner_registration_tokens_runner_active_expiry_idx"`,
      `SET "version" = 6`,
    ]) {
      expect(migration).toContain(evidence);
    }
  });
});
