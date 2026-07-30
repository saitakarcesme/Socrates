import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { metricDefinitions, projects } from "./projects";
import { experimentStatus, runStatus } from "./enums";
import { nonNegativeCheck, positiveCheck } from "./helpers";

export const runs = pgTable(
  "runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    metricDefinitionId: uuid("metric_definition_id").notNull(),
    sequence: integer("sequence").notNull(),
    title: text("title").notNull(),
    objective: text("objective").notNull(),
    status: runStatus("status").default("draft").notNull(),
    version: integer("version").default(0).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("runs_project_sequence_unique").on(
      table.projectId,
      table.sequence,
    ),
    uniqueIndex("runs_project_id_unique").on(table.projectId, table.id),
    index("runs_project_status_idx").on(table.projectId, table.status),
    index("runs_project_created_id_idx").on(
      table.projectId,
      table.createdAt,
      table.id,
    ),
    foreignKey({
      name: "runs_metric_definition_project_fk",
      columns: [table.projectId, table.metricDefinitionId],
      foreignColumns: [metricDefinitions.projectId, metricDefinitions.id],
    }),
    positiveCheck("runs_sequence_positive", table.sequence),
    nonNegativeCheck("runs_version_non_negative", table.version),
    check(
      "runs_completed_after_started",
      sql`${table.completedAt} IS NULL OR ${table.startedAt} IS NULL OR ${table.completedAt} >= ${table.startedAt}`,
    ),
  ],
);

export const runBudgets = pgTable(
  "run_budgets",
  {
    runId: uuid("run_id")
      .primaryKey()
      .references(() => runs.id),
    maximumExperiments: integer("maximum_experiments").notNull(),
    maximumDurationMs: bigint("maximum_duration_ms", {
      mode: "number",
    }).notNull(),
    maximumCostMinor: bigint("maximum_cost_minor", {
      mode: "number",
    }).notNull(),
  },
  (table) => [
    positiveCheck(
      "run_budgets_maximum_experiments_positive",
      table.maximumExperiments,
    ),
    positiveCheck(
      "run_budgets_maximum_duration_positive",
      table.maximumDurationMs,
    ),
    nonNegativeCheck(
      "run_budgets_maximum_cost_non_negative",
      table.maximumCostMinor,
    ),
  ],
);

export const experiments = pgTable(
  "experiments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id),
    parentExperimentId: uuid("parent_experiment_id"),
    sequence: integer("sequence").notNull(),
    hypothesis: text("hypothesis").notNull(),
    action: text("action").notNull(),
    status: experimentStatus("status").default("proposed").notNull(),
    version: integer("version").default(0).notNull(),
    estimatedDurationMs: bigint("estimated_duration_ms", {
      mode: "number",
    }).notNull(),
    estimatedCostMinor: bigint("estimated_cost_minor", {
      mode: "number",
    }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("experiments_run_sequence_unique").on(
      table.runId,
      table.sequence,
    ),
    unique("experiments_run_id_unique").on(table.runId, table.id),
    index("experiments_run_status_idx").on(table.runId, table.status),
    index("experiments_run_created_id_idx").on(
      table.runId,
      table.createdAt,
      table.id,
    ),
    foreignKey({
      name: "experiments_parent_same_run_fk",
      columns: [table.runId, table.parentExperimentId],
      foreignColumns: [table.runId, table.id],
    }),
    positiveCheck("experiments_sequence_positive", table.sequence),
    nonNegativeCheck("experiments_version_non_negative", table.version),
    positiveCheck(
      "experiments_estimated_duration_positive",
      table.estimatedDurationMs,
    ),
    nonNegativeCheck(
      "experiments_estimated_cost_non_negative",
      table.estimatedCostMinor,
    ),
    check(
      "experiments_parent_not_self",
      sql`${table.parentExperimentId} IS NULL OR ${table.parentExperimentId} <> ${table.id}`,
    ),
    check(
      "experiments_completed_after_started",
      sql`${table.completedAt} IS NULL OR ${table.startedAt} IS NULL OR ${table.completedAt} >= ${table.startedAt}`,
    ),
  ],
);
